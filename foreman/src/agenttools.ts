// The agentcraft tool surface, as backend-agnostic logic.
//
// Both backends expose the same tools but deliver them differently:
//   claude  an in-process MCP server (the tools describe themselves with zod and run here)
//   pi      an extension inside the pi process, which cannot see `fm`, so it calls back over
//           the foreman's local HTTP channel and the logic runs here
//
// Keeping the bodies here means the two cannot drift. The transports own their schemas, the
// inbox piggyback and the abort rules; this module owns only what a tool DOES.
import { formatInbox } from './bus.js';
import type { Foreman } from './foreman.js';
import type { AgentState, Decision, TaskStatus } from './protocol.js';
import { MERGE_OPTIONS } from './protocol.js';
import { truncate } from './util/text.js';
import { userName } from './user.js';

export type ToolRole = 'lead' | 'worker';

/** Side effects a backend may want to react to. */
export interface ToolHooks {
  /** worker moved its task to review */
  onReview(agentId: string, taskId: string): void;
  /** lead asked for changes on a task (status -> doing) */
  onChangesRequested(taskId: string, feedback: string): void;
  /** a task was created (scheduler tick) */
  onTasksChanged(): void;
  /** lead requested a merge (decision created) */
  onMergeRequested(taskId: string, decision: Decision): void;
  /** agent is blocked waiting for the user */
  onWaiting(agentId: string, waiting: boolean): void;
}

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

const ok = (text: string): ToolOutcome => ({ ok: true, text });
const bad = (text: string): ToolOutcome => ({ ok: false, text });

export const TOOL_COMMON = [
  'send_message',
  'ask_user',
  'write_memory',
  'read_memory',
  'update_task',
  'report_status',
  'list_tasks',
];
export const TOOL_LEAD = ['create_task', 'request_merge'];

export function toolNamesFor(role: ToolRole): string[] {
  return role === 'lead' ? [...TOOL_COMMON, ...TOOL_LEAD] : [...TOOL_COMMON];
}

export function boardSummary(fm: Foreman, goalId?: string): string {
  const tasks = fm.tasks.list().filter((t) => !goalId || t.goalId === goalId);
  if (!tasks.length) return '(no tasks yet)';
  return tasks
    .map(
      (t) =>
        `- ${t.id} [${t.status}] ${t.title}${t.assignee ? ` (${fm.nameOf(t.assignee)})` : ''}${t.deps.length ? ` deps: ${t.deps.join(', ')}` : ''}`,
    )
    .join('\n');
}

/**
 * A task in review whose worktree changed nothing (a report, an investigation): there is nothing
 * to merge, so it is closed as done (worktree abandoned, branch kept) instead of asking the user to
 * approve an empty merge. Returns true if it was closed.
 */
export async function closeIfNoChanges(fm: Foreman, taskId: string): Promise<boolean> {
  const t = fm.tasks.get(taskId);
  if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return false;
  await fm.repos.refresh(t.repoId);
  const wt = fm.repos.findWorktree(t.repoId, t.worktree);
  if (!wt || wt.status !== 'active' || wt.files > 0) return false;
  await fm.repos.abandon(t.repoId, wt.id, `agentcraft: ${t.id} (no changes)`);
  fm.tasks.setStatus(t.id, 'done', { force: true, summary: t.summary ?? 'no changes' });
  fm.bus.feed('task', `${t.id} changed no files (report only): closed as done, nothing to merge`, {
    agentId: t.assignee ?? 'marlow',
  });
  const who = t.assignee;
  if (who && fm.agent(who)?.taskId === t.id) {
    fm.setAgent(who, { state: 'idle', station: 'lounge', activity: `${t.id} done`, taskId: null, worktree: null });
  }
  return true;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/**
 * Run one tool call. `params` arrives as loose JSON (over HTTP) or typed (from the SDK), so every
 * field is validated here rather than trusted.
 */
export async function runAgentTool(
  fm: Foreman,
  agentId: string,
  role: ToolRole,
  name: string,
  params: Record<string, unknown>,
  hooks: ToolHooks,
): Promise<ToolOutcome> {
  /** Append any unread messages, so a teammate's note lands mid-turn rather than next turn. */
  const withInbox = (text: string, isError = false): ToolOutcome => {
    const inbox = fm.bus.inbox(agentId, { markRead: true });
    const extra = inbox.length ? `\n\n[New messages]\n${formatInbox(inbox, (id) => fm.nameOf(id))}` : '';
    return { ok: !isError, text: text + extra };
  };
  const fail = (text: string) => withInbox(`Error: ${text}`, true);

  switch (name) {
    case 'send_message': {
      const to = str(params.to);
      const text = str(params.text);
      if (!to || !text) return fail('send_message needs "to" and "text"');
      let target = to.trim().toLowerCase();
      if (target === 'lead') target = 'marlow';
      if (!['all', 'user'].includes(target)) {
        const id = fm.resolveAgentId(target);
        if (!id) return fail(`no teammate "${to}". Team: ${fm.agents().filter((a) => a.active).map((a) => a.id).join(', ')}`);
        target = id;
      }
      if (target === agentId) return fail('you cannot message yourself');
      fm.bus.send(agentId, target, text);
      // A worker reads messages only while it works on a task: one with no task would read this
      // whenever its next task starts, so a request sent this way silently never happens.
      if (role === 'lead' && !['all', 'user'].includes(target) && !fm.agent(target)?.taskId) {
        return withInbox(
          `Sent to ${target}, but ${fm.nameOf(target)} is not on a task, so they will only read it when their next task starts. ` +
            `To have ${fm.nameOf(target)} do something now, create a task for it with create_task (assignee "${target}").`,
        );
      }
      return withInbox(`Sent to ${target}.`);
    }

    case 'write_memory': {
      const title = str(params.title);
      const body = str(params.body);
      if (!title || body === undefined) return fail('write_memory needs "title" and "body"');
      const scope = str(params.scope);
      const mode = str(params.mode);
      const e = fm.memory.write({
        scope: scope === 'private' ? agentId : 'shared',
        title,
        body,
        author: agentId,
        mode: mode === 'append' ? 'append' : 'replace',
      });
      fm.bus.feed('memory', `${fm.nameOf(agentId)} wrote memory: ${e.title}`, { agentId });
      return withInbox(`Saved memory ${e.id}.`);
    }

    case 'read_memory': {
      const id = str(params.id);
      const query = str(params.query);
      if (id) {
        const e = fm.memory.get(id) ?? fm.memory.get(`shared/${id}`) ?? fm.memory.get(`${agentId}/${id}`);
        if (!e || (e.scope !== 'shared' && e.scope !== agentId)) return fail(`no memory ${id}`);
        return withInbox(`# ${e.title} (${e.id})\n\n${e.body}`);
      }
      const list = query ? fm.memory.search(query, agentId) : fm.memory.visibleTo(agentId);
      if (!list.length) return withInbox('No memory notes.');
      if (query && list.length <= 3) {
        return withInbox(list.map((e) => `# ${e.title} (${e.id})\n\n${truncate(e.body, 3000)}`).join('\n\n---\n\n'));
      }
      return withInbox(list.map((e) => `- ${e.id}: ${e.title}`).join('\n'));
    }

    case 'update_task': {
      const taskId = str(params.task_id);
      if (!taskId) return fail('update_task needs "task_id"');
      const t = fm.tasks.get(taskId);
      if (!t) return fail(`no task ${taskId}. ${boardSummary(fm)}`);
      const status = str(params.status);
      const summary = str(params.summary);
      const blocked = str(params.blocked_reason);
      const assignee = str(params.assignee);
      const title = str(params.title);
      const description = str(params.description);

      if (role === 'worker') {
        const current = fm.agent(agentId)?.taskId;
        if (t.assignee !== agentId) return fail(`${t.id} is not your task`);
        if (current && t.id !== current) {
          return fail(
            `you are working on ${current}; you can only update that task. Tell Marlow (send_message to "lead") if ${t.id} is already covered.`,
          );
        }
        if (status && !['review', 'blocked', 'doing'].includes(status)) return fail('workers can set status review, blocked or doing');
        if (assignee || title || description) return fail('only the lead can change assignee/title/description');
      }
      try {
        if (assignee) {
          const id = fm.resolveAgentId(assignee);
          if (!id) return fail(`no agent ${assignee}`);
          fm.tasks.update(t.id, { assignee: id });
        }
        if (title) fm.tasks.update(t.id, { title });
        if (description) fm.tasks.update(t.id, { description });
        if (summary) fm.tasks.update(t.id, { summary });
        if (status && status !== t.status) {
          const prev = t.status;
          fm.tasks.setStatus(t.id, status as TaskStatus, {
            force: role === 'lead' || status === 'review',
            ...(blocked ? { reason: blocked } : {}),
            ...(summary ? { summary } : {}),
          });
          fm.bus.feed('task', `${fm.nameOf(agentId)}: ${t.id} ${prev} -> ${status}`, { agentId });
          if (status === 'review' && role === 'worker') hooks.onReview(agentId, t.id);
          if (status === 'doing' && prev === 'review' && role === 'lead') {
            hooks.onChangesRequested(t.id, summary ?? 'see review comments');
          }
        }
        hooks.onTasksChanged();
        return withInbox(`Updated ${t.id}: ${fm.tasks.get(t.id)?.status ?? t.status}.`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    case 'report_status': {
      const activity = str(params.activity);
      if (!activity) return fail('report_status needs "activity"');
      fm.setAgent(agentId, { activity: activity.slice(0, 80) });
      const note = str(params.note);
      if (note) fm.agentLog(agentId, 'text', note);
      return withInbox('ok');
    }

    case 'list_tasks':
      return withInbox(boardSummary(fm));

    case 'create_task': {
      if (role !== 'lead') return fail('only the lead can create tasks');
      const title = str(params.title);
      const description = str(params.description);
      if (!title || description === undefined) return fail('create_task needs "title" and "description"');
      const goal = fm.currentGoal();
      let who: string | undefined;
      const assignee = str(params.assignee);
      if (assignee) {
        who = fm.resolveAgentId(assignee);
        if (!who) return fail(`no worker ${assignee}`);
        if (fm.agent(who)?.role === 'lead') return fail('assign tasks to workers, not yourself');
      }
      try {
        const t = fm.tasks.create({
          title,
          description,
          deps: strArray(params.deps) ?? [],
          ...(who ? { assignee: who } : {}),
          ...(typeof params.priority === 'number' ? { priority: params.priority } : {}),
          createdBy: agentId,
          ...(goal ? { goalId: goal.id } : {}),
          ...(goal?.repoId ? { repoId: goal.repoId } : {}),
        });
        fm.bus.feed('task', `${fm.nameOf(agentId)} created ${t.id}: ${t.title}`, { agentId });
        hooks.onTasksChanged();
        return withInbox(`Created ${t.id}.`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    case 'request_merge': {
      if (role !== 'lead') return fail('only the lead can request a merge');
      const taskId = str(params.task_id);
      if (!taskId) return fail('request_merge needs "task_id"');
      const t = fm.tasks.get(taskId);
      if (!t) return fail(`no task ${taskId}`);
      if (t.status !== 'review') return fail(`${t.id} is ${t.status}, not in review`);
      if (!t.worktree || !t.repoId) return fail(`${t.id} has no worktree to merge`);
      // The merge is the one place that actually puts code on the base branch, so this is where
      // the test gate has to bite. Checking only the status makes CI advisory: a task whose tests
      // failed can be moved back to review and merged, and the failure is then in the base branch.
      if (t.ci === 'fail') {
        return fail(
          `${t.id} has failing tests (ci: fail). Fix them before asking to merge - ${userName()} cannot merge it either.`,
        );
      }
      if (t.ci !== 'pass') {
        // Never merge on trust. If CI has not run for this task (moved to review by hand, or the
        // foreman restarted mid-flight) run it now rather than assume it passed.
        fm.repos.setCi(t.repoId, 'running');
        const ci = await fm.repos.runTests(t.repoId, t.worktree);
        fm.repos.setCi(t.repoId, ci.pass ? 'pass' : 'fail');
        fm.tasks.update(t.id, { ci: ci.pass ? 'pass' : 'fail' });
        if (!ci.pass) {
          return fail(`${t.id} failed its tests (${ci.command}):\n${ci.output}`);
        }
      }
      const open = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === t.id);
      if (open) return withInbox(`Merge decision ${open.id} for ${t.id} is already waiting for ${userName()}.`);
      if (await closeIfNoChanges(fm, t.id)) {
        hooks.onTasksChanged();
        return withInbox(
          `${t.id} changed no files, so there is nothing to merge: it is closed as done. Tell ${userName()} the result with send_message if you have not yet.`,
        );
      }
      const wt = fm.repos.requireWorktree(t.repoId, t.worktree);
      const summary = str(params.summary) ?? 'see review comments';
      const d = fm.createDecision({
        agentId,
        kind: 'merge',
        question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
        options: [...MERGE_OPTIONS],
        context: `${summary}\n${wt.files} files, +${wt.additions} -${wt.deletions} | tests: ${t.ci}`,
        taskId: t.id,
        repoId: t.repoId,
        worktree: wt.id,
      });
      hooks.onMergeRequested(t.id, d);
      return withInbox(`Merge decision ${d.id} sent to ${userName()}.`);
    }

    default:
      return fail(`unknown tool "${name}"`);
  }
}

/**
 * `ask_user` is deliberately NOT in the switch above.
 *
 * It is the one tool that blocks until a human answers, and each backend gets that from a
 * different place: the claude SDK server creates a Decision and awaits it in-process, while a pi
 * extension calls `ctx.ui.select()`, which pi turns into a dialog the PiBackend maps onto a
 * Decision. Routing it through here would give pi two competing decision paths for one question.
 */
export const ASK_USER_HANDLED_BY_BACKEND = true;

/** Kept for the claude path, which awaits the Decision inside its own tool handler. */
export type { AgentState };

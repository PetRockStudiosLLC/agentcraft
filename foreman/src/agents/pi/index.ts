// pi backend: real pi sessions driving the studio, one `pi --mode rpc` process per agent.
//
// Same shape as the claude backend - a job queue per agent, one turn per job, session ids
// persisted per (agent, task|goal) - but the transport is pi's RPC mode instead of the Claude
// Agent SDK.
//
// Two things are simpler here than in the claude backend:
//   * the decision surface needs no MCP server. pi's own `ctx.ui.*` calls arrive as
//     `extension_ui_request` messages, so an agent that needs a human already shows up as a
//     blocking request we can turn into a Decision and answer on the same pipe.
//   * `get_state` / `get_messages` give us reconciliation after a Foreman restart for free.
//
// Deviation from the claude backend worth knowing: pi is spawned with extension discovery OFF
// (see PI_MINIMAL_ARGS). A studio pi loads calendar, Google auth, guardrails, MCP adapter, Unity
// and llama-cpp at startup and will not answer a command until that finishes. Six agents each
// paying that cost is both slow and wrong - these agents belong to the target repo, not the
// studio. Explicit `-e` paths still load, which is how the agentcraft extension gets in.
import fs from 'node:fs';
import path from 'node:path';
import { ClientError, type Backend, type Foreman } from '../../foreman.js';
import { FOREMAN_VERSION, type PiConfig } from '../../config.js';
import type { Decision, Goal, Task } from '../../protocol.js';
import { toolActivity } from '../activity.js';
import { runAgentTool, type ToolHooks, type ToolOutcome } from '../../agenttools.js';
import { renderDiffText } from '../../diff.js';
import { PiRpc, type UiRequest } from './rpc.js';
import { leadSystemPrompt, planPrompt, reviewPrompt, workPrompt } from './prompts.js';

export type JobKind = 'plan' | 'work' | 'review' | 'followup';

/**
 * Flags every agent process runs with. `--no-extensions` is load-bearing: without it pi tries to
 * boot the whole studio extension stack and the command loop stalls behind it.
 */
export const PI_MINIMAL_ARGS = [
  '--mode',
  'rpc',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
];

interface Job {
  kind: JobKind;
  agentId: string;
  prompt: string;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
}

/** A dialog the agent is blocked on, and the Decision standing in for it. */
interface PendingDialog {
  request: UiRequest;
  decisionId: string;
}

interface AgentProc {
  rpc: PiRpc;
  sessionKey: string;
  /** directory the process was spawned in. A worker's differs per task (its own worktree). */
  cwd: string;
  inflight?: Job;
  /** off shift until resume/spawn */
  stopped: boolean;
  dialogs: Map<string, PendingDialog>;
  /** set while a turn is running so we do not treat an idle gap as completion */
  running: boolean;
}

interface PiState {
  /** `agentId` -> session key currently bound, so a restart resumes the same conversation */
  sessions: Record<string, string>;
  stopped: string[];
}

export class PiBackend implements Backend {
  readonly name = 'pi' as const;
  private readonly procs = new Map<string, AgentProc>();
  /** partial line per agent, so streamed fragments do not reach the monitor mid-word */
  private readonly textBuf = new Map<string, string>();
  private closing = false;

  constructor(
    private readonly fm: Foreman,
    private readonly cfg: PiConfig,
  ) {}

  private get state(): PiState {
    const b = this.fm.store.data.backend;
    let st = b.pi as PiState | undefined;
    if (!st) {
      st = { sessions: {}, stopped: [] };
      b.pi = st;
      this.fm.store.markDirty();
    }
    return st;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // The connection banner reads `auth`. Left at the default it stays 'unknown' forever, which
    // is indistinguishable from "not checked yet". There is no login to verify for pi, but the
    // CLI has to exist, and that is the one failure worth showing loudly.
    const cli = this.cfg.piArgs[0];
    if (!cli || !fs.existsSync(cli)) {
      this.fm.setStatus({ auth: 'failed', message: `pi CLI not found at ${cli ?? '(unset)'}` });
      this.fm.log.error(`pi: CLI not found at ${cli ?? '(unset)'} - set AGENTCRAFT_PI_CLI to its path`);
      return;
    }
    this.fm.setStatus({ auth: 'ok', message: `pi (${this.cfg.model ?? 'default model'})` });

    // Bring the configured team on shift. The roster creates workers as 'off shift'
    // (active: false) and only the lead starts active, so a backend that never activates them
    // leaves the scheduler with an EMPTY TEAM: the lead plans, tasks land on the wall, and
    // nothing ever runs. Nothing errors - the goal is active, the task is ready, and no worker
    // moves - which is the worst way for this to fail.
    const onShift: string[] = [];
    for (const id of this.cfg.workers) {
      const a = this.fm.agent(id);
      if (!a || a.role !== 'worker' || this.state.stopped.includes(id)) continue;
      this.fm.setAgent(id, { active: true });
      this.fm.act(id, 'idle', 'lounge', 'on shift');
      onShift.push(id);
    }
    this.fm.log.info(`pi: team on shift [${onShift.join(', ')}]`);

    // Reconcile: a goal that was mid-flight when the Foreman stopped is resumed by the lead -
    // but only with a repo, or the agents plan and then work inside the foreman's own checkout.
    const goal = this.fm.currentGoal();
    if (!this.cfg.repoPath) {
      if (goal) {
        this.fm.log.warn(`pi: goal ${goal.id} is waiting, but no repo is connected - add one with /repo add <path>`);
      }
      return;
    }
    if (goal && goal.status === 'planning') {
      this.fm.log.info(`pi: resuming planning for goal ${goal.id}`);
      await this.submitGoal(goal);
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    const all = [...this.procs.values()].map((p) => p.rpc.stop());
    await Promise.allSettled(all);
    this.procs.clear();
  }

  // ---- goal ------------------------------------------------------------------------------

  async submitGoal(goal: Goal): Promise<void> {
    const lead = this.leadAgent();
    if (!lead) throw new ClientError('pi backend: no lead agent in the cast');
    // Refuse rather than fall back to process.cwd(). The foreman's own checkout is not a
    // workspace: a worker given it creates a worktree of the tooling and edits that, which is a
    // startling thing for opening the game to do.
    if (!this.cfg.repoPath) {
      throw new ClientError('pi backend: no repo connected - add one with /repo add <path>');
    }
    await this.runJob(
      lead.id,
      {
        kind: 'plan',
        agentId: lead.id,
        prompt: planPrompt(goal),
        sessionKey: `goal:${goal.id}`,
        goalId: goal.id,
      },
      this.cfg.repoPath ?? process.cwd(),
    );
  }

  // ---- user / foreman callbacks -------------------------------------------------------------

  /**
   * Run one agentcraft tool for an agent. Called by the foreman's local tool channel: the pi
   * extension cannot reach `fm`, so tool calls come back through here.
   *
   * The role comes from the AGENT RECORD, never from the request. Otherwise a worker could claim
   * to be the lead and create tasks or approve its own work.
   */
  async runTool(
    agentId: string,
    _claimedRole: string,
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const a = this.fm.agent(agentId);
    if (!a) return { ok: false, text: `Error: no agent ${agentId}` };
    return runAgentTool(this.fm, agentId, a.role, name, params, this.toolHooks());
  }

  /**
   * The tool layer reports board changes so a backend can wake a scheduler. The pi backend has no
   * scheduler yet, so these are deliberately inert rather than pretending to dispatch: a task the
   * lead creates sits on the wall until a worker is started by hand.
   */
  private toolHooks(): ToolHooks {
    return {
      onReview: () => undefined,
      onChangesRequested: () => undefined,
      // The lead creating a task is what starts the studio. Without this the wall never moves.
      onTasksChanged: () => {
        void this.schedule().catch((e) => this.fm.log.error(`pi schedule: ${(e as Error).message}`));
      },
      onMergeRequested: () => undefined,
      onWaiting: () => undefined,
    };
  }

  onUserMessage(to: string, text: string): void {
    const id = this.fm.resolveAgentId(to);
    if (!id) {
      this.fm.log.warn(`pi: user message to unknown agent "${to}"`);
      return;
    }
    const p = this.procs.get(id);
    if (!p || !p.rpc.alive) {
      // Not running: start a fresh turn carrying the message.
      void this.runJob(
        id,
        { kind: 'followup', agentId: id, prompt: text, sessionKey: this.sessionKeyFor(id) },
        this.cwdFor(id),
      ).catch((e) => this.fm.log.error(`pi followup: ${(e as Error).message}`));
      return;
    }
    // Mid-turn: steer (delivered after the current tool batch, before the next model call).
    const send = p.running ? p.rpc.steer(text) : p.rpc.followUp(text);
    send.catch((e) => this.fm.log.error(`pi steer: ${(e as Error).message}`));
    this.fm.agentLog(id, 'text', `[user] ${text}`);
  }

  onDecisionSettled(d: Decision): void {
    const p = this.procs.get(d.agentId);
    if (!p) return;
    const pending = p.dialogs.get(d.id);
    if (!pending) return; // not ours (e.g. a merge decision handled by the core)
    p.dialogs.delete(d.id);

    const answer = d.answer;
    if (d.status === 'cancelled' || (!answer?.option && !answer?.text)) {
      p.rpc.respondTo(pending.request, { cancelled: true });
    } else {
      p.rpc.respondTo(pending.request, {
        option: answer?.option,
        text: answer?.text,
        confirmed: answer?.option === 'Yes',
      });
    }
    const who = this.fm.nameOf(d.agentId);
    this.fm.agentLog(d.agentId, 'text', `[answered] ${answer?.option ?? answer?.text ?? 'cancelled'}`);
    this.fm.act(d.agentId, 'thinking', 'desk', `${who} resuming`);
  }

  onTaskAction(task: Task, action: 'reassign' | 'cancel' | 'retry' | 'prioritize', arg?: string): void {
    // v1: task lifecycle is driven by the target repo's own graph; nothing to do on the wire yet.
    this.fm.log.info(`pi: task action ${action} on ${task.id}${arg ? ` (${arg})` : ''}`);
  }

  async onAgentAction(
    agentId: string,
    action: 'pause' | 'resume' | 'stop' | 'spawn',
    _arg?: string,
  ): Promise<void> {
    const st = this.state;
    if (action === 'stop') {
      st.stopped = [...new Set([...st.stopped, agentId])];
      this.fm.store.markDirty();
      await this.killProc(agentId);
      const t = this.fm.agent(agentId);
      if (t?.taskId) delete t.taskId;
      this.fm.setAgent(agentId, { active: false, paused: false });
      this.fm.act(agentId, 'idle', 'lounge', 'off shift');
      return;
    }
    if (action === 'resume' || action === 'spawn') {
      st.stopped = st.stopped.filter((x) => x !== agentId);
      this.fm.store.markDirty();
      this.fm.setAgent(agentId, { active: true, paused: false });
      this.fm.act(agentId, 'idle', 'lounge', 'waiting for work');
      return;
    }
    if (action === 'pause') {
      const p = this.procs.get(agentId);
      this.fm.setAgent(agentId, { paused: true });
      this.fm.act(agentId, 'idle', 'lounge', 'paused');
      await p?.rpc.abort().catch(() => undefined);
    }
  }

  // ---- processes ---------------------------------------------------------------------------

  private leadAgent() {
    return this.fm.agents().find((a) => a.role === 'lead');
  }

  private sessionKeyFor(agentId: string): string {
    return this.state.sessions[agentId] ?? `agent:${agentId}`;
  }

  private async ensureProc(agentId: string, cwd: string): Promise<AgentProc> {
    const existing = this.procs.get(agentId);
    if (existing?.rpc.alive && existing.cwd === cwd) return existing;
    if (existing) {
      // The directory changed (a worker moved to another task's worktree). cwd is fixed at spawn,
      // so the old process is useless: continuing a session from the wrong directory edits the
      // wrong checkout, and nothing surfaces that until the diff is reviewed.
      await this.killProc(agentId);
    }

    const a = this.fm.requireAgent(agentId);
    const rpc = new PiRpc({
      bin: this.cfg.piBin,
      args: [...this.cfg.piArgs, ...PI_MINIMAL_ARGS, '--session-dir', this.sessionDir(agentId)],
      cwd,
      // The extension reads these to reach the foreman and to know who it is. They are set per
      // process, so one agent cannot act as another the way a shared config file would allow.
      env: {
        ...process.env,
        AGENTCRAFT_AGENT_ID: agentId,
        AGENTCRAFT_AGENT_ROLE: a.role,
        ...(this.cfg.channelPort
          ? { AGENTCRAFT_TOOL_URL: `http://127.0.0.1:${this.cfg.channelPort}/agent-tool` }
          : {}),
        ...(this.cfg.channelToken ? { AGENTCRAFT_TOOL_TOKEN: this.cfg.channelToken } : {}),
      },
      commandTimeoutMs: 30_000,
    });
    const proc: AgentProc = {
      rpc,
      sessionKey: this.sessionKeyFor(agentId),
      cwd,
      stopped: false,
      dialogs: new Map(),
      running: false,
    };

    rpc.on('event', (msg) => this.onEvent(agentId, msg));
    rpc.on('ui-request', (req) => this.onUiRequest(agentId, req));
    rpc.on('stderr', (t) => {
      const s = t.trim();
      if (s) this.fm.log.info(`pi[${a.name}]: ${s.slice(0, 200)}`);
    });
    rpc.on('badline', (l) => this.fm.log.warn(`pi[${a.name}]: non-JSON on stdout: ${l.slice(0, 120)}`));
    rpc.on('error', (e) => this.fm.log.error(`pi[${a.name}]: ${e.message}`));
    rpc.on('exit', (code) => {
      this.flushText(agentId);
      proc.running = false;
      if (this.closing) return;
      // An agent that dies mid-turn would otherwise sit at its desk forever, looking busy.
      const dies = proc.inflight !== undefined;
      this.procs.delete(agentId);
      if (dies) {
        this.fm.agentLog(agentId, 'error', `pi exited (code ${code}) mid-turn`);
        this.fm.act(agentId, 'error', 'desk', 'session ended unexpectedly');
      }
    });

    rpc.start();
    this.procs.set(agentId, proc);
    this.fm.log.info(`pi[${a.name}]: started (FOREMAN ${FOREMAN_VERSION})`);
    return proc;
  }

  private sessionDir(agentId: string): string {
    return path.join(this.cfg.home, 'pi-sessions', agentId);
  }

  private async killProc(agentId: string): Promise<void> {
    const p = this.procs.get(agentId);
    if (!p) return;
    this.procs.delete(agentId);
    await p.rpc.stop().catch(() => undefined);
  }

  // ---- jobs --------------------------------------------------------------------------------

  private async runJob(agentId: string, job: Job, cwd: string): Promise<void> {
    const a = this.fm.requireAgent(agentId);
    const proc = await this.ensureProc(agentId, cwd);
    this.fm.act(agentId, 'thinking', 'desk', `${a.name} is thinking`);
    this.fm.agentLog(agentId, 'text', `[${job.kind}] ${firstLine(job.prompt)}`);
    proc.inflight = job;
    proc.running = true;
    try {
      // Resolves when pi ACCEPTS the prompt, not when the turn ends. The job therefore stays
      // inflight until agent_end: clearing it here would make a working agent look idle and throw
      // away the task id needed to close the job out.
      await proc.rpc.prompt(`${leadSystemPrompt(this.fm)}\n\n${job.prompt}`);
    } catch (e) {
      proc.running = false;
      if (proc.inflight === job) delete proc.inflight;
      this.fm.agentLog(agentId, 'error', `pi prompt failed: ${(e as Error).message}`);
      this.fm.act(agentId, 'error', 'desk', 'prompt failed');
    }
  }

  // ---- scheduling ----------------------------------------------------------------------------

  /** Where an agent should run: its task's worktree when it has one, else the repo root. */
  private cwdFor(agentId: string): string {
    const a = this.fm.agent(agentId);
    if (a?.repoId && a.worktree) {
      const wt = this.fm.repos.findWorktree(a.repoId, a.worktree);
      if (wt?.status === 'active') return wt.path;
    }
    return this.cfg.repoPath ?? process.cwd();
  }

  /** Workers that can take work: active, not stopped off shift. */
  private team(): string[] {
    return this.fm
      .agents()
      .filter((a) => a.role === 'worker' && a.active && !this.state.stopped.includes(a.id))
      .map((a) => a.id);
  }

  private isFree(agentId: string): boolean {
    if (this.procs.get(agentId)?.running) return false;
    return !this.fm.tasks.list().some((t) => t.assignee === agentId && (t.status === 'doing' || t.status === 'review'));
  }

  private workersRunning(): number {
    return [...this.procs.values()].filter((p) => p.running).length;
  }

  /**
   * Hand ready tasks to free workers. This is what makes the wall live: without it the tasks the
   * lead writes are inert text, and the studio is one agent talking to itself.
   */
  private async schedule(): Promise<void> {
    if (this.closing) return;
    const active = this.fm.goals().filter((g) => g.status === 'active');
    const ready = active.flatMap((g) => this.fm.tasks.ready(g.id));
    this.fm.log.info(
      `pi: schedule - ${active.length} active goal(s), ${ready.length} ready task(s), ${this.workersRunning()} running, team [${this.team().join(', ')}]`,
    );

    // Reviews first. A finished task with no merge decision waiting is the lead's next job, and
    // skipping it stops the loop at "in review": the work is committed, and nothing ever asks the
    // user to merge it. One at a time, because the lead is a single agent.
    const lead = this.leadAgent();
    if (lead?.active && !this.procs.get(lead.id)?.running) {
      const next = this.fm.tasks
        .list()
        .find(
          (t) =>
            t.status === 'review' &&
            t.worktree &&
            !this.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === t.id),
        );
      if (next) {
        await this.reviewTask(lead.id, next.id);
        return;
      }
    }

    for (const goal of active) {
      for (const t of this.fm.tasks.ready(goal.id)) {
        if (this.workersRunning() >= this.cfg.maxConcurrent) return;
        // Honour an existing assignee, otherwise take any free worker.
        const preferred = t.assignee && this.team().includes(t.assignee) ? t.assignee : undefined;
        const w = preferred ?? this.team().find((x) => this.isFree(x));
        if (!w || !this.isFree(w)) continue;
        try {
          await this.startWork(w, t, goal);
        } catch (e) {
          // The task stays on the board; a later schedule() will try again.
          this.fm.log.error(`pi: could not start ${t.id} for ${w}: ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * Hand a finished task to the lead for review, with its real diff. Without this the loop stops
   * at "in review": the work is committed, the tests pass, and nothing ever reaches the user.
   */
  private async reviewTask(leadId: string, taskId: string): Promise<void> {
    const t = this.fm.tasks.get(taskId);
    if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return;
    try {
      await this.fm.repos.refresh(t.repoId);
      const diff = await this.fm.repos.diff(t.repoId, t.worktree);
      this.fm.act(leadId, 'reading', 'mergestation', `reviewing ${t.id}`);
      this.fm.bus.feed('task', `${this.fm.nameOf(leadId)} is reviewing ${t.id}`, { agentId: leadId });
      await this.runJob(
        leadId,
        {
          kind: 'review',
          agentId: leadId,
          prompt: reviewPrompt(t, renderDiffText(diff.files)),
          sessionKey: `review:${t.id}`,
          taskId: t.id,
          ...(t.goalId ? { goalId: t.goalId } : {}),
        },
        this.cwdFor(leadId),
      );
    } catch (e) {
      this.fm.agentLog(leadId, 'error', `could not review ${t.id}: ${(e as Error).message}`);
    }
  }

  private async startWork(agentId: string, t: Task, goal: Goal): Promise<void> {
    const repoId = t.repoId ?? goal.repoId;
    if (!repoId) throw new Error(`task ${t.id} has no repo`);
    if (!t.repoId) this.fm.tasks.update(t.id, { repoId });
    this.fm.tasks.update(t.id, { assignee: agentId });
    // A worktree per task, always. The worker's whole process is pointed at it, so it cannot
    // touch another agent's checkout or the user's.
    const wt = await this.fm.repos.createWorktree(repoId, agentId, t);
    this.fm.tasks.update(t.id, { branch: wt.branch, worktree: wt.id });
    this.fm.tasks.setStatus(t.id, 'doing');
    this.fm.setAgent(agentId, { taskId: t.id, repoId, worktree: wt.id, active: true });
    this.fm.act(agentId, 'thinking', 'desk', `starting ${t.id}`);
    this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} started ${t.id}: ${t.title}`, { agentId });
    await this.runJob(
      agentId,
      { kind: 'work', agentId, prompt: workPrompt(t, wt.path), sessionKey: `task:${t.id}`, taskId: t.id, goalId: goal.id },
      wt.path,
    );
  }

  /**
   * A worker's turn ended. Commit whatever it left behind and move the task to review.
   *
   * The commit is done here rather than left to the agent: an agent that says it is finished but
   * never committed leaves a worktree that cannot be merged, so the task would look done while
   * being worthless. A dirty worktree is a normal outcome, not an error.
   */
  private async finishWork(agentId: string, taskId: string): Promise<void> {
    const t = this.fm.tasks.get(taskId);
    if (!t || t.status !== 'doing' || !t.repoId || !t.worktree) return;
    try {
      await this.fm.repos.refresh(t.repoId);
      const wt = this.fm.repos.findWorktree(t.repoId, t.worktree);
      if (wt && wt.status === 'active' && (wt.files > 0 || wt.ahead > 0)) {
        await this.fm.repos.commitAll(t.repoId, t.worktree, `agentcraft: ${t.id} ${t.title}`);
      }
      this.fm.tasks.setStatus(t.id, 'review', { force: true });
      this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} finished ${t.id}: in review`, { agentId });
      this.fm.setAgent(agentId, { taskId: null, worktree: null });
      this.fm.act(agentId, 'idle', 'lounge', `${t.id} in review`);
      // The lead reviews next; a finished worker frees a slot for the next ready task.
      await this.schedule();
    } catch (e) {
      const msg = (e as Error).message;
      this.fm.agentLog(agentId, 'error', `could not finish ${t.id}: ${msg}`);
      this.fm.tasks.setStatus(t.id, 'blocked', { reason: msg });
      this.fm.act(agentId, 'blocked', 'desk', 'blocked');
    }
  }

  /** A turn ended: the plan made the goal live, or a worker's task needs closing out. */
  private async onJobEnd(agentId: string, job: Job): Promise<void> {
    this.fm.log.info(`pi: ${job.kind} turn ended for ${this.fm.nameOf(agentId)}`);
    if (job.kind === 'plan' && job.goalId) {
      this.fm.setGoal(job.goalId, { status: 'active' });
      this.fm.agentLog(agentId, 'text', 'plan complete; handing work out');
      this.fm.log.info(`pi: goal ${job.goalId} is active; scheduling work`);
      await this.schedule();
      return;
    }
    if (job.kind === 'work' && job.taskId) {
      await this.finishWork(agentId, job.taskId);
      return;
    }
    if (job.kind === 'review') {
      // The lead either requested a merge (a decision is now waiting on the user) or sent the task
      // back. A task sent back is 'doing' again, and `tasks.ready()` only returns work that has not
      // started - so without this branch the worker is never re-dispatched and the task stalls
      // silently, holding a worktree nobody will touch.
      const t = job.taskId ? this.fm.tasks.get(job.taskId) : undefined;
      const goal = t?.goalId ? this.fm.goal(t.goalId) : this.fm.currentGoal();
      if (t && t.status === 'doing' && t.assignee && goal) {
        this.fm.log.info(`pi: ${t.id} sent back to ${t.assignee}; re-dispatching`);
        this.fm.bus.feed('task', `${this.fm.nameOf(job.agentId)} sent ${t.id} back for changes`, {
          agentId: job.agentId,
        });
        await this.startWork(t.assignee, t, goal);
        return;
      }
      await this.schedule();
    }
  }

  // ---- event mapping -----------------------------------------------------------------------

  private onEvent(agentId: string, msg: Record<string, unknown>): void {
    const type = String(msg.type ?? '');
    const proc = this.procs.get(agentId);

    switch (type) {
      case 'agent_start':
        this.fm.act(agentId, 'thinking', 'desk', 'reading the request');
        return;
      case 'agent_end':
      case 'agent_settled':
        // Turn over: emit the trailing partial line rather than swallowing it.
        this.flushText(agentId);
        if (proc) {
          const job = proc.inflight;
          proc.running = false;
          if (proc.inflight === job) delete proc.inflight;
          if (job) {
            void this.onJobEnd(agentId, job).catch((e) => this.fm.log.error(`pi job end: ${(e as Error).message}`));
          }
        }
        return;
      case 'turn_start':
        this.fm.act(agentId, 'thinking', 'desk', 'thinking');
        return;
      case 'message_update':
        this.onMessageUpdate(agentId, msg);
        return;
      case 'tool_execution_start':
        this.onToolStart(agentId, msg);
        return;
      case 'tool_execution_end':
        this.onToolEnd(agentId, msg);
        return;
      case 'extension_error':
        this.fm.agentLog(agentId, 'error', String(msg.error ?? 'extension error'));
        return;
      case 'auto_retry_start':
        this.fm.agentLog(agentId, 'error', `retrying: ${String(msg.reason ?? '')}`);
        this.fm.act(agentId, 'blocked', 'desk', 'retrying after an error');
        return;
      case 'queue_update':
      case 'compaction_start':
      case 'compaction_end':
        return;
      default:
        // Unknown event types are not errors; pi adds them. Stay quiet rather than spam monitors.
        return;
    }
  }

  private onMessageUpdate(agentId: string, msg: Record<string, unknown>): void {
    const inner = msg.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!inner) return;
    const kind = String(inner.type ?? '');
    if (kind === 'text_delta') {
      this.pushText(agentId, String(inner.delta ?? ''));
      return;
    }
    if (kind === 'thinking') {
      this.fm.act(agentId, 'thinking', 'desk', 'thinking it through');
    }
  }

  /**
   * Streamed text arrives as arbitrary fragments, so logging each delta puts mid-word lines in
   * the monitor ("one.  **Open"). Buffer per agent and emit only complete lines.
   */
  private pushText(agentId: string, delta: string): void {
    if (!delta) return;
    let buf = (this.textBuf.get(agentId) ?? '') + delta;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (line) this.fm.agentLog(agentId, 'text', line);
    }
    this.textBuf.set(agentId, buf);
  }

  /** Emit whatever is left in the buffer. Safe to call more than once. */
  private flushText(agentId: string): void {
    const rest = (this.textBuf.get(agentId) ?? '').trim();
    this.textBuf.delete(agentId);
    if (rest) this.fm.agentLog(agentId, 'text', rest);
  }

  private onToolStart(agentId: string, msg: Record<string, unknown>): void {
    const tool = String(msg.toolName ?? msg.tool ?? 'tool');
    const input = (msg.input ?? msg.args ?? {}) as Record<string, unknown>;
    const act = toolActivity(normalizeToolName(tool), input);
    this.fm.act(agentId, act.state, act.station, act.activity);
    this.fm.agentLog(agentId, 'tool', act.label || tool);
  }

  private onToolEnd(agentId: string, msg: Record<string, unknown>): void {
    const tool = String(msg.toolName ?? msg.tool ?? 'tool');
    const isError = msg.isError === true || msg.error !== undefined;
    if (isError) {
      // The error field is often absent - pi reports a failed tool with isError alone. Dump the
      // frame rather than logging a bare "failed", which says nothing about the cause.
      const detail = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg).slice(0, 400);
      this.fm.agentLog(agentId, 'error', `${tool}: ${detail}`);
      return;
    }
    const result = typeof msg.result === 'string' ? msg.result : '';
    if (result) this.fm.agentLog(agentId, 'result', result.slice(0, 400));
  }

  // ---- decision surface ---------------------------------------------------------------------

  /**
   * A blocking `ctx.ui.*` call from the agent. This is the podium: the agent is stopped until a
   * human answers, so it must become a Decision rather than a log line.
   */
  private onUiRequest(agentId: string, req: UiRequest): void {
    const proc = this.procs.get(agentId);
    if (!proc) return;

    // pi attaches a timeout to dialogs and auto-resolves with `undefined` if the client is slow.
    // Here a human is expected to take their time, and the decision stays open until answered -
    // so the timeout is deliberately ignored rather than honoured.
    // With extension discovery OFF, our ask_user is the only thing that raises a dialog: it uses
    // select (with options) or input. A bare yes/no `confirm` is the one we do not raise, so that
    // is the only shape treated as a permission prompt.
    const kind: Decision['kind'] = req.method === 'confirm' ? 'permission' : 'question';
    const options =
      req.method === 'select'
        ? (req.options ?? [])
        : req.method === 'confirm'
          ? ['Yes', 'No']
          : ['Continue'];

    const d = this.fm.createDecision({
      agentId,
      kind,
      question: req.title ?? 'The agent needs a decision',
      options,
      context: [req.message, req.prefill].filter(Boolean).join('\n\n') || undefined,
      tool: req.method,
    });
    proc.dialogs.set(d.id, { request: req, decisionId: d.id });
    this.fm.act(agentId, 'waiting_user', 'user', `asking: ${shorten(req.title ?? 'a question')}`);
    this.fm.notify('need_user', `${this.fm.nameOf(agentId)} needs a decision`, d.id);
  }
}

// ---- helpers ---------------------------------------------------------------------------------

function firstLine(s: string): string {
  const l = s.split('\n').find((x) => x.trim());
  return (l ?? '').trim().slice(0, 80);
}

function shorten(s: string): string {
  return s.length > 34 ? `${s.slice(0, 33)}\u2026` : s;
}

/**
 * pi's built-in tool names are lowercase; `activity.ts` was written against the Claude SDK's
 * capitalised names. Bridge the two so the shared mapping keeps working.
 */
function normalizeToolName(tool: string): string {
  const map: Record<string, string> = {
    read: 'Read',
    write: 'Edit',
    edit: 'Edit',
    multiedit: 'MultiEdit',
    grep: 'Grep',
    glob: 'Glob',
    ls: 'LS',
    bash: 'Bash',
    ask_user: 'ask_user',
  };
  return map[tool.toLowerCase()] ?? tool;
}

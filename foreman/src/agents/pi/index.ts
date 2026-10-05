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
import path from 'node:path';
import { ClientError, type Backend, type Foreman } from '../../foreman.js';
import { FOREMAN_VERSION, type PiConfig } from '../../config.js';
import type { Decision, Goal, Task } from '../../protocol.js';
import { toolActivity } from '../activity.js';
import { runAgentTool, type ToolHooks, type ToolOutcome } from '../../agenttools.js';
import { PiRpc, type UiRequest } from './rpc.js';
import { leadSystemPrompt, planPrompt } from './prompts.js';

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
    this.fm.setStatus({ message: `pi backend (${this.cfg.provider ?? 'default model'})` });
    // Reconcile: any goal that was mid-flight when the Foreman stopped is resumed by the lead.
    const goal = this.fm.currentGoal();
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
    await this.runJob(lead.id, {
      kind: 'plan',
      agentId: lead.id,
      prompt: planPrompt(goal),
      sessionKey: `goal:${goal.id}`,
      goalId: goal.id,
    });
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
      onTasksChanged: () => undefined,
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
      void this.runJob(id, {
        kind: 'followup',
        agentId: id,
        prompt: text,
        sessionKey: this.sessionKeyFor(id),
      }).catch((e) => this.fm.log.error(`pi followup: ${(e as Error).message}`));
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

  private async ensureProc(agentId: string): Promise<AgentProc> {
    const existing = this.procs.get(agentId);
    if (existing?.rpc.alive) return existing;

    const a = this.fm.requireAgent(agentId);
    const rpc = new PiRpc({
      bin: this.cfg.piBin,
      args: [...this.cfg.piArgs, ...PI_MINIMAL_ARGS, '--session-dir', this.sessionDir(agentId)],
      cwd: this.cfg.repoPath ?? process.cwd(),
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

  private async runJob(agentId: string, job: Job): Promise<void> {
    const a = this.fm.requireAgent(agentId);
    const proc = await this.ensureProc(agentId);
    this.fm.act(agentId, 'thinking', 'desk', `${a.name} is thinking`);
    this.fm.agentLog(agentId, 'text', `[${job.kind}] ${firstLine(job.prompt)}`);
    proc.inflight = job;
    proc.running = true;
    try {
      await proc.rpc.prompt(`${leadSystemPrompt(this.fm)}\n\n${job.prompt}`);
    } catch (e) {
      this.fm.agentLog(agentId, 'error', `pi prompt failed: ${(e as Error).message}`);
      this.fm.act(agentId, 'error', 'desk', 'prompt failed');
    } finally {
      proc.running = false;
      if (proc.inflight === job) delete proc.inflight;
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
        if (proc) proc.running = false;
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

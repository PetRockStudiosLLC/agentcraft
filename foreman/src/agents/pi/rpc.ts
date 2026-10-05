// pi RPC client: one `pi --mode rpc` process per agent, JSONL over stdin/stdout.
//
// Framing is LF-only, hand-rolled. pi's docs are explicit that a generic line reader is NOT
// protocol-compliant here: Node's `readline` also splits on U+2028 and U+2029, which are legal
// inside JSON strings and do appear in code and prose. Splitting on those would tear a record in
// half and the backend would see a truncation error that looks like a model failure.
//
// Two directions on one pipe:
//   stdin  -> commands (prompt/steer/follow_up/abort/...) and extension_ui_response
//   stdout -> command responses (correlated by `id`) and async events
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { killTree } from '../../util/proc.js';

export interface RpcOptions {
  /** Executable: an absolute path to pi's CLI bundle, or a bare `pi` on PATH. */
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** How long a command waits for its `response` before rejecting. 0 = wait forever. */
  commandTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

/** A dialog request from the agent that is blocking until we answer. */
export interface UiRequest {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}

export declare interface PiRpc {
  on(event: 'event', l: (msg: Record<string, unknown>) => void): this;
  on(event: 'ui-request', l: (req: UiRequest) => void): this;
  on(event: 'stderr', l: (text: string) => void): this;
  on(event: 'exit', l: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', l: (err: Error) => void): this;
  on(event: 'badline', l: (line: string) => void): this;
}

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export class PiRpc extends EventEmitter {
  private child: ChildProcess | undefined;
  private buf = '';
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private exited = false;

  constructor(private readonly opts: RpcOptions) {
    super();
  }

  get alive(): boolean {
    return !this.exited && !!this.child?.stdin?.writable;
  }

  start(): void {
    if (this.child) throw new Error('pi rpc: already started');
    const child = spawn(this.opts.bin, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));

    // stderr is the agent's own logging, never protocol. Surface it for the foreman log.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk));

    child.on('error', (err) => this.emit('error', err));
    child.on('exit', (code, signal) => {
      this.exited = true;
      // Anything still waiting can never be answered now.
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`pi rpc: process exited (code ${code}, signal ${signal})`));
      }
      this.pending.clear();
      this.emit('exit', code, signal);
    });
  }

  /** LF-only framing. Keeps a partial tail in `buf` until its newline arrives. */
  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1); // tolerate CRLF input
      if (!line.trim()) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A non-JSON line on stdout is a bug in the protocol, not a reason to kill the run.
        this.emit('badline', line);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'string' ? msg.id : undefined;

    // Command response: settle the matching promise.
    if (msg.type === 'response' && id && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.success === false) p.reject(new Error(String(msg.error ?? 'pi rpc: command failed')));
      else p.resolve(msg);
      return;
    }

    // A blocking dialog. The backend turns this into a Decision and answers via respond().
    if (msg.type === 'extension_ui_request') {
      const method = String(msg.method ?? '');
      if (DIALOG_METHODS.has(method)) {
        this.emit('ui-request', {
          id: String(msg.id),
          method: method as UiRequest['method'],
          title: msg.title as string | undefined,
          message: msg.message as string | undefined,
          options: msg.options as string[] | undefined,
          placeholder: msg.placeholder as string | undefined,
          prefill: msg.prefill as string | undefined,
          timeout: msg.timeout as number | undefined,
        } satisfies UiRequest);
      }
      // notify / setStatus / setWidget / setTitle are fire-and-forget: still an event so the
      // backend can drive nameplates and monitors from them.
    }

    this.emit('event', msg);
  }

  private write(obj: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new Error('pi rpc: stdin is not writable');
    stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /** Send a command and await its correlated response. */
  command<T = Record<string, unknown>>(
    type: string,
    args: Record<string, unknown> = {},
    timeoutMs = this.opts.commandTimeoutMs ?? 30_000,
  ): Promise<T> {
    const id = `c${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`pi rpc: ${type} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ id, type, ...args });
      } catch (e) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  // ---- command surface (thin, so it reads like the protocol) -------------------------------

  prompt(message: string, timeoutMs?: number) {
    return this.command('prompt', { message }, timeoutMs);
  }
  steer(message: string) {
    return this.command('steer', { message });
  }
  followUp(message: string) {
    return this.command('follow_up', { message });
  }
  abort() {
    return this.command('abort', {});
  }
  newSession() {
    return this.command('new_session', {});
  }
  getState<T = Record<string, unknown>>() {
    return this.command<T>('get_state', {});
  }
  getMessages<T = Record<string, unknown>>() {
    return this.command<T>('get_messages', {});
  }

  /**
   * Answer a blocking dialog. Field names differ per method - sending `value` to a `confirm`
   * leaves the agent waiting forever, which reads as a hang rather than an error.
   */
  respondTo(req: UiRequest, answer: { option?: string; text?: string; confirmed?: boolean; cancelled?: boolean }): void {
    const id = req.id;
    if (answer.cancelled) {
      this.write({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }
    if (req.method === 'confirm') {
      this.write({ type: 'extension_ui_response', id, confirmed: answer.confirmed ?? false });
      return;
    }
    // select / input / editor all reply with `value`
    this.write({ type: 'extension_ui_response', id, value: answer.option ?? answer.text ?? '' });
  }

  /** Kill the process tree. A bare kill would orphan the model/child processes it started. */
  async stop(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      // Walks the whole tree. A bare kill orphans the model and child processes the agent
      // started, and on Windows those keep the worktree busy.
      killTree(child);
    } catch {
      /* already gone */
    }
    const timedOut = await Promise.race([
      ended.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), graceMs)),
    ]);
    if (timedOut) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await ended.catch(() => undefined);
  }
}

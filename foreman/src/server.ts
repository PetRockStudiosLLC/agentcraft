// WebSocket server: ws://127.0.0.1:<port>. Clients send `hello` and get a `snapshot`, then every
// upsert. Multiple clients (the mod + CLI tools) are supported. Any browser origin (also `null`) and
// non-loopback Host headers are rejected, so a web page cannot drive your agents.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ToolOutcome, ToolRole } from './agenttools.js';
import type { Logger } from './context.js';
import type { Foreman } from './foreman.js';
import { parseClientMessage, PROTOCOL_VERSION, ServerMessage, type Outbound } from './protocol.js';

export interface ServerOptions {
  host: string;
  port: number;
  allowBrowserOrigins?: boolean;
  /** validate every outbound message against the schema (tests/dev) */
  validateOutbound?: boolean;
  /**
   * Shared secret for the local tool channel, so another local process cannot drive the agents.
   * Passed to agent processes via the environment; absent means the channel is tokenless (tests).
   */
  toolToken?: string;
  /**
   * Run an agentcraft tool on behalf of an agent whose tools live outside this process. Supplied
   * by the backend; a backend with in-process tools (claude) leaves it unset and the route 501s.
   */
  runTool?: (agentId: string, role: ToolRole, name: string, params: Record<string, unknown>) => Promise<ToolOutcome>;
  log: Logger;
}

/** Host header values a local client sends (DNS rebinding sends the attacker's host name). */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Why a WebSocket upgrade is refused, or undefined to accept. The mod (Java HttpClient) and our
 * CLI tools send no Origin header; every browser does, and a sandboxed iframe, a data: URL or a
 * file:// page sends the literal `null`, so any Origin at all - `null` included - is a web page.
 * The Host must be a loopback name, so a DNS-rebinding page cannot reach us under its own name.
 */
export function refuseReason(req: IncomingMessage, allowBrowserOrigins = false): string | undefined {
  const origin = req.headers.origin;
  if (origin !== undefined && !allowBrowserOrigins) return `browser origin ${origin || '(empty)'}`;
  const host = req.headers.host ?? '';
  if (!allowBrowserOrigins && !LOOPBACK_HOST.test(host)) return `non-loopback Host header ${host || '(none)'}`;
  return undefined;
}

interface Client {
  ws: WebSocket;
  id: number;
  hello: boolean;
  name: string;
  alive: boolean;
}

export class ForemanServer {
  private wss: WebSocketServer | undefined;
  private http: HttpServer | undefined;
  private clients = new Set<Client>();
  private unsub: (() => void) | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private nextId = 1;
  port = 0;

  constructor(
    private foreman: Foreman,
    private opts: ServerOptions,
  ) {}

  get clientCount(): number {
    return [...this.clients].filter((c) => c.hello).length;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // One listener serves both: the WebSocket upgrade and the local tool channel. A separate
      // port would be a second thing to configure and secure for no benefit.
      const httpServer = createServer((req, res) => void this.onHttp(req, res));
      const wss = new WebSocketServer({
        server: httpServer,
        maxPayload: 4 * 1024 * 1024,
        verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
          const why = refuseReason(info.req, !!this.opts.allowBrowserOrigins);
          if (!why) return true;
          this.opts.log.warn(`rejected WebSocket: ${why}`);
          return false;
        },
      });
      this.http = httpServer;
      this.wss = wss;
      httpServer.once('error', (e) => reject(e));
      httpServer.listen(this.opts.port, this.opts.host, () => {
        const addr = httpServer.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        resolve(this.port);
      });
      httpServer.on('error', (e) => this.opts.log.error(`http server: ${e.message}`));
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
      this.unsub = this.foreman.subscribe((m) => this.broadcast(m));
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) {
          if (!c.alive) {
            c.ws.terminate();
            continue;
          }
          c.alive = false;
          try {
            c.ws.ping();
          } catch {
            /* ignore */
          }
        }
      }, 15_000);
      this.heartbeat.unref?.();
    });
  }

  /**
   * The local tool channel: how an agent whose tools run OUTSIDE this process (a pi extension)
   * reaches `fm`. Guarded exactly like the socket - loopback Host only, plus a bearer token - so
   * a web page cannot drive the agents and neither can another local user.
   */
  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!(req.url ?? '').startsWith('/agent-tool')) return reply(404, { error: 'not found' });
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });

    const host = req.headers.host ?? '';
    if (!this.opts.allowBrowserOrigins && !LOOPBACK_HOST.test(host)) {
      this.opts.log.warn(`rejected tool call: non-loopback Host ${host || '(none)'}`);
      return reply(403, { error: 'forbidden' });
    }
    if (this.opts.toolToken && req.headers['x-agentcraft-token'] !== this.opts.toolToken) {
      this.opts.log.warn('rejected tool call: bad or missing token');
      return reply(403, { error: 'forbidden' });
    }

    let body: { agentId?: unknown; role?: unknown; tool?: unknown; params?: unknown };
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof body;
    } catch {
      return reply(400, { error: 'bad JSON body' });
    }

    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    const tool = typeof body.tool === 'string' ? body.tool : '';
    const role: ToolRole = body.role === 'lead' ? 'lead' : 'worker';
    if (!agentId || !tool) return reply(400, { error: 'agentId and tool are required' });
    if (!this.opts.runTool) return reply(501, { error: 'this backend has no tool channel' });
    if (!this.foreman.agent(agentId)) return reply(400, { error: `no agent ${agentId}` });

    try {
      const params = (body.params ?? {}) as Record<string, unknown>;
      return reply(200, await this.opts.runTool(agentId, role, tool, params));
    } catch (e) {
      this.opts.log.error(`agent tool ${tool} failed: ${(e as Error).message}`);
      return reply(500, { ok: false, text: `Error: ${(e as Error).message}` });
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = { ws, id: this.nextId++, hello: false, name: `client${this.nextId - 1}`, alive: true };
    this.clients.add(client);
    this.opts.log.info(`client #${client.id} connected from ${req.socket.remoteAddress ?? '?'}`);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) {
        this.send(client, { type: 'error', message: 'binary frames are not supported' });
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        let re: string | undefined;
        try {
          const raw = JSON.parse(data.toString()) as { id?: unknown };
          if (typeof raw.id === 'string') re = raw.id;
        } catch {
          /* ignore */
        }
        this.send(client, { type: 'error', message: `bad message: ${parsed.error}`, ...(re ? { re } : {}) });
        if (re) this.send(client, { type: 'ack', re, ok: false, error: parsed.error });
        return;
      }
      const msg = parsed.msg;
      if (msg.type === 'hello') {
        client.hello = true;
        client.name = `${msg.client ?? 'client'}#${client.id} (${msg.modVersion})`;
        this.opts.log.info(`hello from ${client.name}`);
      } else if (!client.hello) {
        // be lenient: treat the first intent as an implicit hello so tools can fire-and-forget
        client.hello = true;
      }
      void this.foreman.handle(msg, (out) => this.send(client, out));
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.opts.log.info(`client #${client.id} disconnected`);
    });
    ws.on('error', (e) => this.opts.log.warn(`client #${client.id}: ${e.message}`));
  }

  private serialize(m: Outbound): string | undefined {
    const full = { v: PROTOCOL_VERSION, ...m };
    if (this.opts.validateOutbound) {
      const r = ServerMessage.safeParse(full);
      if (!r.success) {
        this.opts.log.error(`outbound ${m.type} violates protocol: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        throw new Error(`outbound ${m.type} violates protocol`);
      }
    }
    return JSON.stringify(full);
  }

  private send(c: Client, m: Outbound): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    const s = this.serialize(m);
    if (s) c.ws.send(s);
  }

  broadcast(m: Outbound): void {
    let s: string | undefined;
    for (const c of this.clients) {
      if (!c.hello || c.ws.readyState !== c.ws.OPEN) continue;
      s ??= this.serialize(m);
      if (s) c.ws.send(s);
    }
  }

  async stop(): Promise<void> {
    this.unsub?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) {
      try {
        c.ws.close(1001, 'foreman shutting down');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
      setTimeout(() => {
        for (const c of this.clients) c.ws.terminate();
        resolve();
      }, 1000).unref?.();
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
      setTimeout(resolve, 1000).unref?.();
    });
  }
}

// Does `abort` actually stop a running turn? Isolated, because the studio test could not tell
// whether the abort was ignored or the turn simply finished first.
//
// Run: node --import tsx scripts/pi-abort-smoke.ts
import os from 'node:os';
import path from 'node:path';
import { PI_MINIMAL_ARGS } from '../src/agents/pi/index.js';
import { PiRpc } from '../src/agents/pi/rpc.js';

const CLI =
  process.env.AGENTCRAFT_PI_CLI ??
  path.join(os.homedir(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');

const rpc = new PiRpc({
  bin: process.execPath,
  args: [CLI, ...PI_MINIMAL_ARGS, '--no-session'],
  cwd: process.cwd(),
  commandTimeoutMs: 30_000,
});

const t0 = Date.now();
const ts = () => String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5) + 's';
let deltas = 0;
let ended = false;
let settle: () => void = () => undefined;
const settled = new Promise<void>((r) => {
  settle = r;
});

rpc.on('event', (msg) => {
  const t = String(msg.type ?? '');
  if (t === 'message_update') {
    const inner = msg.assistantMessageEvent as { type?: string } | undefined;
    if (inner?.type === 'text_delta') deltas++;
  }
  if (t === 'agent_end' || t === 'agent_settled') {
    if (!ended) console.log(ts(), 'agent_end');
    ended = true;
    settle();
  }
});
rpc.on('stderr', (s) => {
  const x = s.trim();
  if (x) console.log(ts(), '[stderr]', x.slice(0, 160));
});

rpc.start();
await rpc.getState();

console.log(ts(), 'prompt: long essay (should stream for a while)');
await rpc.prompt('Write a 1500 word essay on the history of computing. Plain prose, no tools.');

// Abort after a few seconds of streaming.
setTimeout(() => {
  console.log(ts(), `>>> abort (deltas so far: ${deltas})`);
  rpc
    .abort()
    .then((r) => console.log(ts(), 'abort responded:', JSON.stringify(r).slice(0, 120)))
    .catch((e) => console.log(ts(), 'abort FAILED:', (e as Error).message));
}, 6_000);

await Promise.race([settled, new Promise((r) => setTimeout(r, 90_000))]);
const elapsed = (Date.now() - t0) / 1000;
console.log(ts(), `final: ended=${ended} deltas=${deltas} elapsed=${elapsed.toFixed(1)}s`);
console.log(
  ended && elapsed < 40
    ? '\nRESULT: OK - abort stopped the turn'
    : ended
      ? '\nRESULT: INCONCLUSIVE - the turn ended, but not promptly; it may just have finished'
      : '\nRESULT: FAILED - abort did not end the turn',
);
await rpc.stop();
process.exit(0);

// End-to-end smoke test for the pi backend's transport. Costs a few cents at most.
//
// Proves, in order:
//   1. `pi --mode rpc` starts with the backend's own minimal flags
//   2. LF-only framing reassembles records
//   3. command/response correlation by `id` works        (get_state)
//   4. a real prompt streams events back                  (prompt -> message_update -> agent_settled)
//
// Flags are imported from the backend, not copied, so this cannot drift from what PiBackend
// actually spawns.
//
// Run: node --import tsx scripts/pi-rpc-smoke.ts
import os from 'node:os';
import path from 'node:path';
import { PI_MINIMAL_ARGS } from '../src/agents/pi/index.js';
import { PiRpc } from '../src/agents/pi/rpc.js';

const CLI =
  process.env.AGENTCRAFT_PI_CLI ??
  path.join(os.homedir(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');

const rpc = new PiRpc({
  // Absolute node, never the bare name: spawn would otherwise resolve through PATH, which is
  // exactly what breaks on this machine.
  bin: process.execPath,
  args: [CLI, ...PI_MINIMAL_ARGS, '--no-session'],
  cwd: process.cwd(),
  commandTimeoutMs: 30_000,
});

const counts = new Map<string, number>();
let streamed = '';
let settle: () => void = () => undefined;
const settled = new Promise<void>((r) => {
  settle = r;
});

rpc.on('event', (msg) => {
  const t = String(msg.type ?? '');
  counts.set(t, (counts.get(t) ?? 0) + 1);
  if (t === 'message_update') {
    const inner = msg.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (inner?.type === 'text_delta') streamed += inner.delta ?? '';
  }
  if (t === 'agent_settled' || t === 'agent_end') settle();
});
rpc.on('ui-request', (req) => console.log(`  UI REQUEST: ${req.method} - ${req.title ?? ''}`));
rpc.on('badline', (l) => console.log(`  !! FRAMING BUG, non-JSON line: ${l.slice(0, 120)}`));
rpc.on('stderr', (t) => {
  const s = t.trim();
  if (s) console.log(`  [stderr] ${s.slice(0, 200)}`);
});
rpc.on('exit', (code) => console.log(`  pi exited: ${code}`));

console.log(`cli: ${CLI}`);
rpc.start();

try {
  const state = (await rpc.getState()) as { data?: { model?: { id?: string }; thinkingLevel?: string } };
  console.log(`1-3 OK  get_state -> model=${state.data?.model?.id} thinking=${state.data?.thinkingLevel}`);

  console.log('4  sending prompt...');
  await rpc.prompt('Reply with the single word PONG and nothing else. Do not use any tools.');

  await Promise.race([settled, new Promise((r) => setTimeout(r, 120_000))]);

  console.log(`\n  streamed text: ${JSON.stringify(streamed.trim().slice(0, 200))}`);
  console.log('  event histogram:');
  for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${t}`);
  }
  console.log(
    streamed.toLowerCase().includes('pong')
      ? '\nRESULT: OK - prompt -> stream -> settle all work'
      : '\nRESULT: transport worked, but no PONG text seen (check the histogram)',
  );
} catch (e) {
  console.log(`\nRESULT: FAILED -> ${(e as Error).message}`);
} finally {
  await rpc.stop();
  process.exit(0);
}

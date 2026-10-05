// Podium smoke test: proves the agentcraft extension loads AND the decision loop closes.
//
// This is the one test that matters for the extension, because `extensions/` is not in the
// foreman's tsconfig `include` - the extension is never typechecked by `tsc`. Only loading it
// and calling the tool proves it works. A file whose imports do not resolve parses fine and
// fails on first use.
//
// Sequence under test:
//   prompt -> model calls ask_user -> ctx.ui.select() blocks
//          -> extension_ui_request{method:"select"} on stdout
//          -> we answer extension_ui_response{value} on stdin
//          -> the tool returns, the model continues, and it names the option we picked
//
// Picking the SECOND option on purpose: if the answer were ignored (or a default returned) the
// model would say the first one, and the test would catch it.
//
// Run: node --import tsx scripts/pi-podium-smoke.ts
import os from 'node:os';
import path from 'node:path';
import { PI_MINIMAL_ARGS } from '../src/agents/pi/index.js';
import { PiRpc } from '../src/agents/pi/rpc.js';

const CLI =
  process.env.AGENTCRAFT_PI_CLI ??
  path.join(os.homedir(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const EXT = path.join(process.cwd(), 'extensions', 'agentcraft-pi', 'index.ts');

const PICKS = ['Red', 'Blue', 'Green'];
const EXPECTED = 'Blue';

const rpc = new PiRpc({
  bin: process.execPath,
  args: [CLI, ...PI_MINIMAL_ARGS, '-e', EXT, '--no-session'],
  cwd: process.cwd(),
  commandTimeoutMs: 30_000,
});

let streamed = '';
let gotUiRequest = false;
let settle: () => void = () => undefined;
const settled = new Promise<void>((r) => {
  settle = r;
});

rpc.on('event', (msg) => {
  const t = String(msg.type ?? '');
  if (t === 'message_update') {
    const inner = msg.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (inner?.type === 'text_delta') streamed += inner.delta ?? '';
  }
  if (t === 'agent_settled' || t === 'agent_end') settle();
});

rpc.on('ui-request', async (req) => {
  gotUiRequest = true;
  console.log(`  <- UI REQUEST  method=${req.method} title=${JSON.stringify(req.title ?? '')}`);
  console.log(`     options=${JSON.stringify(req.options ?? null)}`);
  // Answer deliberately with the second option.
  rpc.respondTo(req, { option: EXPECTED, text: EXPECTED, confirmed: false });
  console.log(`  -> answered "${EXPECTED}"`);
});

rpc.on('badline', (l) => console.log(`  !! FRAMING BUG: ${l.slice(0, 120)}`));
rpc.on('stderr', (t) => {
  const s = t.trim();
  // Extension load failures surface here.
  if (s) console.log(`  [stderr] ${s.slice(0, 300)}`);
});
rpc.on('exit', (c) => console.log(`  pi exited: ${c}`));

console.log(`extension: ${EXT}`);
rpc.start();

try {
  await rpc.prompt(
    'Call the `ask_user` tool and ask me which colour to use. Offer exactly these options in ' +
      'this order: Red, Blue, Green. Then reply with one short sentence naming the colour I chose.',
  );
  await Promise.race([settled, new Promise((r) => setTimeout(r, 150_000))]);

  const out = streamed.trim();
  console.log(`\n  ui request seen: ${gotUiRequest}`);
  console.log(`  final text: ${JSON.stringify(out.slice(0, 300))}`);
  const named = out.toLowerCase().includes(EXPECTED.toLowerCase());
  console.log(
    gotUiRequest && named
      ? `\nRESULT: OK - extension loaded, ask_user blocked, answer came back, model honoured it`
      : gotUiRequest
        ? `\nRESULT: PARTIAL - the dialog fired but the model did not name "${EXPECTED}"`
        : `\nRESULT: FAILED - no ui request; the extension probably did not load (see stderr)`,
  );
} catch (e) {
  console.log(`\nRESULT: FAILED -> ${(e as Error).message}`);
} finally {
  await rpc.stop();
  process.exit(0);
}

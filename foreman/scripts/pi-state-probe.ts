// Observe a running Foreman over its WebSocket and print what the studio is actually doing.
//
// Agent activity goes to the monitors over the WS, not to the foreman's stdout, so a quiet
// console does not mean a quiet studio. This is the cheap way to see the truth - and it needs
// no knowledge of the protocol: it prints whatever arrives.
//
// Run: node --import tsx scripts/pi-state-probe.ts [port] [seconds]
import WebSocket from 'ws';

const port = Number(process.argv[2] ?? 7879);
const seconds = Number(process.argv[3] ?? 20);

type Out = {
  type?: string;
  agents?: Array<{ name?: string; state?: string; station?: string; activity?: string; taskId?: string }>;
  goal?: { id?: string; text?: string; status?: string; progress?: number };
  tasks?: Array<{ id?: string; title?: string; status?: string; assignee?: string }>;
  decisions?: Array<{ id?: string; agentId?: string; question?: string; status?: string }>;
  agentId?: string;
  entries?: Array<{ kind?: string; text?: string }>;
};

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const counts = new Map<string, number>();

function line(s: string): void {
  console.log(s);
}

ws.on('open', () => line(`connected to ws://127.0.0.1:${port}\n`));
ws.on('error', (e) => {
  line(`ERROR: ${(e as Error).message}`);
  process.exit(1);
});

ws.on('message', (data) => {
  let m: Out;
  try {
    m = JSON.parse(String(data)) as Out;
  } catch {
    return;
  }
  const t = m.type ?? '?';
  counts.set(t, (counts.get(t) ?? 0) + 1);

  if (t === 'snapshot') {
    const g = m.goal;
    line(`GOAL     ${g ? `${g.id} [${g.status}] ${g.progress ?? 0}% - ${String(g.text).slice(0, 70)}` : '(none)'}`);
    for (const a of m.agents ?? []) {
      line(
        `AGENT    ${String(a.name).padEnd(9)} ${String(a.state).padEnd(13)} @${String(a.station).padEnd(12)} ` +
          `${a.taskId ? `[${a.taskId}] ` : ''}${a.activity ?? ''}`,
      );
    }
    for (const tk of m.tasks ?? []) {
      line(`TASK     ${tk.id} [${tk.status}] ${String(tk.assignee ?? '-').padEnd(9)} ${String(tk.title).slice(0, 60)}`);
    }
    for (const d of m.decisions ?? []) {
      line(`DECISION ${d.id} [${d.status}] ${d.agentId}: ${String(d.question).slice(0, 70)}`);
    }
    line('');
  } else if (t === 'agent.log') {
    for (const e of m.entries ?? []) {
      line(`  ${String(m.agentId).padEnd(9)} ${String(e.kind).padEnd(6)} ${String(e.text).replace(/\n/g, ' ').slice(0, 150)}`);
    }
  } else if (t !== 'heartbeat' && t !== 'status') {
    line(`[${t}] ${JSON.stringify(m).slice(0, 220)}`);
  }
});

setTimeout(() => {
  line('\nmessage types seen:');
  for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) line(`  ${String(n).padStart(4)}  ${t}`);
  ws.close();
  process.exit(0);
}, seconds * 1000);

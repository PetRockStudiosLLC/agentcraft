// AgentCraft extension for pi - the tools a studio agent uses to affect the world.
//
// Loaded explicitly by the foreman's pi backend (`-e <this file>`). Extension discovery is OFF
// (`--no-extensions`), so a studio-wide pi config cannot leak into an agent session and an agent
// only sees these tools plus pi's own built-ins.
//
// Tool names and parameter names mirror the Claude backend's MCP server, and the shared
// `src/agents/activity.ts` already maps those exact names (and `input.task_id`) onto world state,
// so the studio's nameplates and stations work unchanged.
//
// HOW A TOOL WORKS: this file runs INSIDE the pi process and cannot see the Foreman. For every
// tool except `ask_user` it POSTs to the foreman's local tool channel; the foreman runs the same
// logic the Claude backend runs in-process (src/agenttools.ts), so the two backends cannot drift.
// The channel is loopback-only and requires the token from the environment.
//
// `ask_user` is the exception and does NOT use the channel: it calls ctx.ui, which pi turns into
// a blocking dialog the PiBackend maps onto a Decision. Routing it through the channel too would
// create two competing decision paths for a single question.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const TOOL_URL = process.env.AGENTCRAFT_TOOL_URL;
const TOKEN = process.env.AGENTCRAFT_TOOL_TOKEN;
const AGENT_ID = process.env.AGENTCRAFT_AGENT_ID;
const ROLE = process.env.AGENTCRAFT_AGENT_ROLE;

/**
 * Call the foreman. Never throws: a tool that rejects would blow up the turn and read to the
 * model as a crash, when what it actually needs to know is "the studio is unreachable, stop".
 */
async function call(tool: string, params: Record<string, unknown>): Promise<string> {
  if (!TOOL_URL || !AGENT_ID) {
    return `Error: this session is not connected to an AgentCraft studio (no ${TOOL_URL ? 'agent id' : 'tool channel'}). Do not retry; just describe what you would have done.`;
  }
  try {
    const res = await fetch(TOOL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-agentcraft-token': TOKEN } : {}) },
      body: JSON.stringify({ agentId: AGENT_ID, role: ROLE, tool, params }),
    });
    const body = (await res.json()) as { ok?: boolean; text?: string; error?: string };
    if (!res.ok) return `Error: ${body.error ?? `studio returned ${res.status}`}`;
    return body.text ?? 'ok';
  } catch (e) {
    return `Error: could not reach the studio (${(e as Error).message}). Do not retry repeatedly.`;
  }
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: {} };
}

export default function agentcraft(pi: ExtensionAPI) {
  // ---- ask_user: the podium, handled locally ------------------------------------------------

  pi.registerTool({
    name: 'ask_user',
    label: 'Ask the human',
    description:
      'Ask the human a question and WAIT for their answer. Use this whenever a decision is genuinely theirs - scope, priority, an ambiguous requirement, or anything you would otherwise have to guess. The turn blocks until they answer. Put your recommended option first.',
    parameters: Type.Object({
      question: Type.String({ description: 'The question, in one sentence.' }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: '2-4 short choices, recommended first. Omit to ask for free text.' }),
      ),
      context: Type.Optional(Type.String({ description: 'one or two lines of background' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options = (params.options ?? []).filter((o) => o && o.trim());
      const dismiss = 'The human dismissed the question without answering. Do not guess - try another approach or ask again.';
      if (options.length > 0) {
        const choice = await ctx.ui.select(params.question, options);
        return text(choice ? `The human chose: ${choice}` : dismiss);
      }
      const answer = await ctx.ui.input(params.question, 'type your answer...');
      return text(answer ? `The human said: ${answer}` : dismiss);
    },
  });

  // ---- task board ---------------------------------------------------------------------------

  pi.registerTool({
    name: 'list_tasks',
    label: 'List tasks',
    description: 'Show the task board (ids, status, assignee, deps).',
    parameters: Type.Object({}),
    async execute() {
      return text(await call('list_tasks', {}));
    },
  });

  pi.registerTool({
    name: 'update_task',
    label: 'Update task',
    description:
      'Update a task. As a worker you can move YOUR task to "review" when it is committed and the tests pass, or "blocked" with blocked_reason. Moving a task in "review" back to "doing" means the reviewer asked for changes.',
    parameters: Type.Object({
      task_id: Type.String({ description: 'the task id, e.g. "t3"' }),
      status: Type.Optional(Type.String({ description: 'todo | doing | review | blocked | cancelled' })),
      summary: Type.Optional(Type.String({ description: 'what you did and how you verified it' })),
      blocked_reason: Type.Optional(Type.String({ description: 'required when status is "blocked"' })),
      assignee: Type.Optional(Type.String({ description: 'lead only' })),
      title: Type.Optional(Type.String({ description: 'lead only' })),
      description: Type.Optional(Type.String({ description: 'lead only' })),
    }),
    async execute(_id, params) {
      return text(await call('update_task', params as Record<string, unknown>));
    },
  });

  pi.registerTool({
    name: 'report_status',
    label: 'Report status',
    description: 'Say in a few words what you are doing right now. This becomes your nameplate in the studio.',
    parameters: Type.Object({
      activity: Type.String({ description: 'e.g. "fixing the tag parser" (max 48 chars)' }),
      note: Type.Optional(Type.String({ description: 'optional longer line for your monitor' })),
    }),
    async execute(_id, params) {
      return text(await call('report_status', params as Record<string, unknown>));
    },
  });

  // ---- communication + memory ---------------------------------------------------------------

  pi.registerTool({
    name: 'send_message',
    label: 'Send message',
    description:
      'Send a short message to a teammate by id or name, "lead", "all" or "user". Not a question - use ask_user for anything that needs an answer.',
    parameters: Type.Object({
      to: Type.String({ description: 'agent id or name, "lead", "all" or "user"' }),
      text: Type.String({ description: 'the message, 1-3 sentences' }),
    }),
    async execute(_id, params) {
      return text(await call('send_message', params as Record<string, unknown>));
    },
  });

  pi.registerTool({
    name: 'write_memory',
    label: 'Write memory',
    description: 'Write a markdown note to memory. scope "shared" (whole team) or "private" (only you).',
    parameters: Type.Object({
      title: Type.String(),
      body: Type.String({ description: 'markdown' }),
      scope: Type.Optional(Type.String({ description: '"shared" or "private"' })),
      mode: Type.Optional(Type.String({ description: '"replace" or "append"' })),
    }),
    async execute(_id, params) {
      return text(await call('write_memory', params as Record<string, unknown>));
    },
  });

  pi.registerTool({
    name: 'read_memory',
    label: 'Read memory',
    description: 'Read memory. With id: that note. With query: matching notes. With neither: list all notes you can see.',
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      return text(await call('read_memory', params as Record<string, unknown>));
    },
  });

  // ---- lead only ----------------------------------------------------------------------------

  // Registered only for the lead. A worker with a create_task tool will eventually try to plan,
  // and the foreman would reject it anyway - better the tool does not exist than that it fails.
  if (ROLE === 'lead') {
    pi.registerTool({
      name: 'create_task',
      label: 'Create task',
      description:
        'Create a task for a worker. deps = task ids that must be merged first. Returns the new task id. Write the description as what to do plus how it will be verified.',
      parameters: Type.Object({
        title: Type.String(),
        description: Type.String({ description: 'what to do + acceptance criteria' }),
        deps: Type.Optional(Type.Array(Type.String(), { description: 'task ids that must land first' })),
        assignee: Type.Optional(Type.String({ description: 'worker id or name' })),
        priority: Type.Optional(Type.Number({ description: 'higher = sooner' })),
      }),
      async execute(_id, params) {
        return text(await call('create_task', params as Record<string, unknown>));
      },
    });

    pi.registerTool({
      name: 'request_merge',
      label: 'Request merge',
      description:
        'After reviewing a task that is in "review": send the human a merge decision for its branch. They decide; you do not wait.',
      parameters: Type.Object({
        task_id: Type.String(),
        summary: Type.String({ description: 'what changed, how it was tested, and any risk' }),
      }),
      async execute(_id, params) {
        return text(await call('request_merge', params as Record<string, unknown>));
      },
    });
  }
}

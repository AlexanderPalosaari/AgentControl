// Board tools for the orchestrator: a stdio MCP server (newline-delimited JSON-RPC, no dependencies) that the
// orchestrator's claude process starts. Every tool is a call to AgentControl's own HTTP API, so the orchestrator
// can do exactly what the person can in the UI and nothing more: it sees cards, never a sub-agent's context.
import { fileURLToPath } from 'node:url';

const STATUSES = ['inbox', 'refining', 'ready', 'running', 'needs_input', 'review', 'done', 'archive'];
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', description: 'Card id, e.g. c-mv6h7l7v8080df' };
const enc = encodeURIComponent;

const shortCard = (c) => ({ id: c.id, title: c.title, status: c.status, priority: c.priority, repos: c.repos, after: c.after ?? null, afterKind: c.afterKind ?? null, project: c.project ?? null });

export const TOOLS = [
  {
    name: 'board_overview',
    description: 'All cards (id, title, column, priority, repos, dependency), the dispatcher (running agents, limit, paused or not) and the projects. Start here. The person has hidden the projects marked hidden: their cards are left out (hiddenCards counts them) and you do not bring them up unless asked about that project by name.',
    inputSchema: obj({}),
    run: async (api) => {
      const [cards, dispatcher, projects] = await Promise.all([api('GET', '/api/cards'), api('GET', '/api/dispatcher'), api('GET', '/api/projects')]);
      return {
        cards: cards.filter((c) => !c.hidden).map(shortCard),
        hiddenCards: cards.filter((c) => c.hidden).length,
        dispatcher,
        projects: projects.map((p) => ({ name: p.name, step: p.step, sourceControl: p.sourceControl.kind === 'github' ? `github ${p.sourceControl.fullName ?? ''}`.trim() : 'local', path: p.path, ...(p.hidden ? { hidden: true } : {}) })),
      };
    },
  },
  {
    name: 'next_steps',
    description: 'What needs the person right now, most urgent first, with card ids and the step to take: the same list as "Sinun vuorosi" on their screen, plus what runs by itself ("working") and what waits for something ("waiting"). When they say "ehdotukset", "seuraava" or "tee seuraava", they mean the first entry of yourTurn.',
    inputSchema: obj({}),
    run: (api) => api('GET', '/api/next'),
  },
  {
    name: 'get_card',
    description: 'One card in full: its brief, the refinement (summary, open questions, plan, ready) and the implementation run (state, the agent\'s question, report, review findings).',
    inputSchema: obj({ id }, ['id']),
    run: async (api, a) => {
      const [card, refine, run, images] = await Promise.all([api('GET', `/api/cards/${enc(a.id)}`), api('GET', `/api/cards/${enc(a.id)}/refine`), api('GET', `/api/cards/${enc(a.id)}/run`), api('GET', `/api/cards/${enc(a.id)}/attachments`)]);
      return {
        card,
        images: images.map((i) => i.name), // the card's own agents look at these; you only see that they exist
        refinement: { state: refine.state, summary: refine.summary, questions: refine.questions, plan: clip(refine.plan, 6000), ready: refine.ready, error: refine.error },
        run: run.run ? { state: run.run.state, error: run.run.error, question: run.question, report: clip(run.report, 6000), review: run.run.review?.findings?.map((f) => `${f.file}: ${f.summary}`) } : null,
        pullRequests: run.prs,
      };
    },
  },
  {
    name: 'list_repos',
    description: 'Names of the git repositories a card can work in.',
    inputSchema: obj({}),
    run: (api) => api('GET', '/api/repos'),
  },
  {
    name: 'create_card',
    description: 'Create a card in Inbox. `after` makes it depend on another card; `afterKind` says whether it needs that card implemented ("done", default) or only its plan approved ("planned").',
    inputSchema: obj({
      title: { type: 'string' }, brief: { type: 'string', description: 'What to do and why, so the card\'s own agent can work from it alone' },
      repos: { type: 'array', items: { type: 'string' } }, priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      after: id, afterKind: { type: 'string', enum: ['done', 'planned'] },
    }, ['title']),
    run: async (api, a) => shortCard(await api('POST', '/api/cards', a)),
  },
  {
    name: 'update_card',
    description: 'Change a card\'s title, brief, priority, repos or dependency (after: null removes it).',
    inputSchema: obj({
      id, title: { type: 'string' }, brief: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      repos: { type: 'array', items: { type: 'string' } }, after: { type: ['string', 'null'] }, afterKind: { type: 'string', enum: ['done', 'planned'] },
    }, ['id']),
    run: async (api, { id: cardId, ...patch }) => shortCard(await api('PATCH', `/api/cards/${enc(cardId)}`, patch)),
  },
  {
    name: 'move_card',
    description: 'Move a card by hand. Only the moves a person may make are allowed (e.g. to archive, review -> done); the rest happen through refinement and work.',
    inputSchema: obj({ id, status: { type: 'string', enum: STATUSES } }, ['id', 'status']),
    run: async (api, a) => shortCard(await api('PATCH', `/api/cards/${enc(a.id)}`, { status: a.status })),
  },
  {
    name: 'start_refinement',
    description: 'Start refining a card in Inbox: its own agent reads the code, asks questions and writes a plan. If the card depends on a card that is not far enough, this answers NEEDS_CONFIRMATION and the person gets a popup to confirm it.',
    inputSchema: obj({ id }, ['id']),
    run: (api, a) => api('POST', `/api/cards/${enc(a.id)}/refine/start`, {}),
  },
  {
    name: 'answer_refinement',
    description: 'Answer the refining agent\'s open questions (answers: question id -> the chosen option label or free text) and/or send it a message. Only with answers the person gave or clearly agreed to.',
    inputSchema: obj({ id, answers: { type: 'object', additionalProperties: { type: 'string' } }, message: { type: 'string' } }, ['id']),
    run: (api, a) => api('POST', `/api/cards/${enc(a.id)}/refine/answer`, { answers: a.answers ?? {}, message: a.message ?? '' }),
  },
  {
    name: 'start_work',
    description: 'Approve a refined card\'s plan: it moves to Ready and the dispatcher starts its implementation agent when a slot is free and its dependency is met. force=true approves a plan that still has open questions; only when the person said so.',
    inputSchema: obj({ id, force: { type: 'boolean' } }, ['id']),
    run: (api, a) => api('POST', `/api/cards/${enc(a.id)}/refine/approve`, { force: a.force === true }),
  },
  {
    name: 'answer_agent',
    description: 'Reply to the question of a card\'s implementation agent (card in Needs input). Only with what the person said.',
    inputSchema: obj({ id, message: { type: 'string' } }, ['id', 'message']),
    run: (api, a) => api('POST', `/api/cards/${enc(a.id)}/run/answer`, { message: a.message }),
  },
  {
    name: 'stop_agent',
    description: 'Stop a card\'s running implementation agent. Only when the person asked.',
    inputSchema: obj({ id }, ['id']),
    run: (api, a) => api('POST', `/api/cards/${enc(a.id)}/run/stop`, {}),
  },
  {
    name: 'retry_agent',
    description: 'Restart a failed or stopped implementation run.',
    inputSchema: obj({ id }, ['id']),
    run: (api, a) => api('POST', `/api/cards/${enc(a.id)}/run/retry`, {}),
  },
  {
    name: 'set_dispatcher',
    description: 'Pause (enabled=false) or resume (true) starting new implementation agents.',
    inputSchema: obj({ enabled: { type: 'boolean' } }, ['enabled']),
    run: (api, a) => api('POST', '/api/dispatcher', { enabled: a.enabled }),
  },
  {
    name: 'create_project',
    description: 'Create a new project: a git repository under the repos root. source "local" (only this machine) or "github" (creates the GitHub repository and pushes). Ask the person where the code should live if they did not say.',
    inputSchema: obj({ name: { type: 'string', description: 'Letters A-Z, digits, ".", "_" or "-"' }, source: { type: 'string', enum: ['local', 'github'] }, owner: { type: 'string', description: 'GitHub user or organization; empty = the signed-in user' } }, ['name', 'source']),
    run: (api, a) => api('POST', '/api/projects', { name: a.name, sourceControl: a.source === 'github' ? { kind: 'github', owner: a.owner ?? '' } : { kind: 'local' } }),
  },
  {
    name: 'delete_project',
    description: 'Ask to delete a project. Nothing is deleted here: the person gets a popup where they choose whether the repository folder goes too, and press OK. Its cards go to the archive; a GitHub repository is never touched.',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    run: async (api, a) => {
      const p = await api('GET', `/api/projects/${enc(a.name)}`);
      throw Object.assign(new Error(`Deleting project "${p.name}" waits for the person's OK.`), { status: 409, data: { confirm: true, project: p.name } });
    },
  },
  {
    name: 'get_project',
    description: 'A project: its step (remote, describe, planning, review, done), where its code lives, the plan and tasks once planned, and codeMap: what the code does, written by an explorer (null when the project has not been explored). Use codeMap to say what a project or app is about.',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    run: async (api, a) => {
      const p = await api('GET', `/api/projects/${enc(a.name)}`);
      const m = await api('GET', `/api/projects/${enc(a.name)}/map`).catch(() => null);
      const codeMap = m?.exploredAt ? { exploredAt: m.exploredAt, stale: m.stale, text: clip(m.text, 4000) } : null;
      return { ...p, planning: { ...p.planning, plan: clip(p.planning.plan, 6000) }, codeMap };
    },
  },
  {
    name: 'recent_commits',
    description: 'The latest commits of a project\'s repositories, newest first (message, author, date), with each repository\'s branch status as in repo_status. Use it for "what was the latest change / what has been done lately" in a project. These are changes in the code itself, not cards on the board.',
    inputSchema: obj({ name: { type: 'string', description: 'Project name' } }, ['name']),
    run: (api, a) => api('GET', `/api/projects/${enc(a.name)}/commits`),
  },
  {
    name: 'repo_status',
    description: 'Where each repository of a project stands: the checked-out branch, the base branch (e.g. origin/main), ahead/behind = commits the branch has that the base lacks / the base has that the branch lacks (ahead 0 means everything on the branch is already in the base), upstream with toPush/toPull, and changed = files with uncommitted changes. Use it for "which branch are we on", "is this already in main", "is anything unpushed". fetch=true fetches the remote first so the remote side is current.',
    inputSchema: obj({ name: { type: 'string', description: 'Project name' }, fetch: { type: 'boolean' } }, ['name']),
    run: (api, a) => api('GET', `/api/projects/${enc(a.name)}/branches${a.fetch ? '?fetch=1' : ''}`),
  },
  {
    name: 'switch_branch',
    description: 'Switch a repository of a project to another branch (one of `switchable` in repo_status), then bring it up to its upstream when that is a fast-forward. Refused when the repository has uncommitted changes. Only when the person asks for it.',
    inputSchema: obj({ name: { type: 'string', description: 'Project name' }, repo: { type: 'string', description: 'Repository name as in repo_status' }, branch: { type: 'string' } }, ['name', 'repo', 'branch']),
    run: (api, a) => api('POST', `/api/projects/${enc(a.name)}/branches`, { repo: a.repo, branch: a.branch }),
  },
  {
    name: 'commit_details',
    description: 'One commit of a project: full message, the changed files with line counts, and the change itself (diff, cut when long). Use it to say what a commit actually did in practice; get the sha from recent_commits.',
    inputSchema: obj({ name: { type: 'string', description: 'Project name' }, sha: { type: 'string', description: 'Commit sha, full or abbreviated' } }, ['name', 'sha']),
    run: (api, a) => api('GET', `/api/projects/${enc(a.name)}/commits?sha=${enc(a.sha)}`),
  },
  {
    name: 'plan_project',
    description: 'Start the project planner (its own agent) from the person\'s description, or send it feedback on the last plan. It runs for minutes in the background: check with get_project later.',
    inputSchema: obj({ name: { type: 'string' }, description: { type: 'string' }, feedback: { type: 'string' } }, ['name']),
    run: (api, a) => api('POST', `/api/projects/${enc(a.name)}/plan`, a.feedback ? { feedback: a.feedback } : { description: a.description ?? '' }),
  },
  {
    name: 'create_project_tasks',
    description: 'Accept a planned project: commits PLAN.md (pushes it when the project is on GitHub) and creates the chosen tasks (0-based numbers; all when left out) as Inbox cards with their dependencies.',
    inputSchema: obj({ name: { type: 'string' }, tasks: { type: 'array', items: { type: 'integer' } } }, ['name']),
    run: (api, a) => api('POST', `/api/projects/${enc(a.name)}/tasks`, a.tasks ? { tasks: a.tasks } : {}),
  },
];

/** Runs a tool and shapes the MCP result; API errors come back as text the model can act on. */
export async function callTool(api, name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  try {
    const out = await tool.run(api, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] };
  } catch (e) {
    // The first line is data for AgentControl (it shows the person an OK popup); the rest is for the model.
    const text = e.status === 409 && e.data?.confirm
      ? `NEEDS_CONFIRMATION ${JSON.stringify({ tool: name, args, ...e.data })}\n${e.message}\nThe person now gets a popup with an OK button for this; pressing OK does the step for them. Do not ask in chat and do not retry: just say that it waits for their OK in the popup.`
      : `Error (${e.status ?? 'failed'}): ${e.message}`;
    return { content: [{ type: 'text', text }], isError: true };
  }
}

export function createApiClient(base, token) {
  return async function api(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
    return data;
  };
}

/** Answers one JSON-RPC message; null for notifications. */
export async function handleMessage(api, msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentcontrol-board', version: '1.0.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': return reply(await callTool(api, msg.params?.name, msg.params?.arguments));
    default:
      if (msg.id === undefined) return null; // a notification such as notifications/initialized
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const api = createApiClient(process.env.AGENTCONTROL_URL, process.env.AGENTCONTROL_TOKEN);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleMessage(api, msg).then((out) => { if (out) process.stdout.write(`${JSON.stringify(out)}\n`); });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

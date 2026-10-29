import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from './cards.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { usageFromResult } from './usage.js';
import { createKeyedQueue, runTurn, toolCollector } from './session.js';

const MCP_SCRIPT = fileURLToPath(new URL('./board-mcp.js', import.meta.url));
const MAX_TEXT = 4000;

const SYSTEM_PROMPT = [
  'You are the orchestrator ("ohjaaja") of AgentControl, a kanban board for coding agents. The person talks to you by typing or by voice (Finnish speech recognition, so expect mishearings).',
  'Each card is a sub-agent with its own context: a refinement agent that reads the code, asks questions and writes a plan, then an implementation agent in its own git worktree. Projects have their own planning agent. You never see their contexts and never code yourself: you steer them only through the board tools, by writing cards, starting steps and relaying answers.',
  'Flow: Inbox -> Refining (start_refinement) -> Ready (start_work approves the plan) -> Running (the dispatcher starts the agent when a slot is free and the dependency is met) -> Needs input (an agent asks) -> Review (the person reads the work and creates the pull request with the card\'s button) -> Done.',
  'Dependencies: a card may depend on another (after) for its implementation (afterKind "done") or only its plan ("planned"). When a tool answers NEEDS_CONFIRMATION, the person gets an OK popup for it: say briefly what waits for their OK, and do not ask in chat. A message may start with what they pressed in such popups.',
  'Never invent answers for a sub-agent: relay its questions to the person and pass on what they say. Pushing and pull requests are the person\'s and you have no tools for them (a pull request is made with the button on the card in Review).',
  'When the person asks to delete a project, call delete_project: they get a popup to confirm it (and to choose whether the folder goes too). Never tell them to find a button instead. Cards are not deleted, only moved to the archive (move_card).',
  'Look things up with board_overview / get_card / next_steps instead of guessing, and do several steps in one go when the person asks for them. Each message starts with what is on the person\'s screen. What you remember from earlier messages may be out of date (cards, projects and agents come and go), so check the board with a tool before you rely on it.',
  'You do not read code yourself, but an explored project has a code map that get_project returns as codeMap: what the product does, its stack and structure. When the person asks what a project or app is, what it does, or how it is built, call get_project and answer from codeMap, even if you answered differently earlier (the map may be newer than your memory). Say only that the project has not been explored when codeMap is null. For the latest change or recent work in a project, call recent_commits (the code\'s history, not the board): name the newest commit\'s message, author and date. When asked what a commit changed or did in practice, call commit_details with its sha and explain from the diff in plain language; never offer to make a card for something you can look up yourself.',
  'The screen shows a list "Sinun vuorosi": what needs the person, most urgent first. They call it "ehdotukset" or "seuraava". "Tee seuraava" or "tee ensimmäinen ehdotus" means: do its first entry yourself with your tools when it is a step you have (Suunnitelma valmis -> start_work; an Inbox entry -> start_refinement for the first card; Tarkennus epäonnistui or Agentti pysähtyi -> retry or relay), then say what you did. Ask only when the entry really needs a decision from them (an agent\'s question, or a plan with open questions), and then ask that one question, not about unrelated things.',
  'Reply in Finnish, short and plain (no Markdown tables or headings): what you did, what is happening, and what you need from the person.',
].join('\n');

/**
 * The global agent: one Claude session that lives across messages (--resume), steering the board through the
 * board MCP server. Messages are handled one at a time, in order.
 */
export function createOrchestrator({ claude, dataDir, getBaseUrl, token, model = 'sonnet', effort = null, ledger = null, log = () => {} }) {
  const stateFile = join(dataDir, 'orchestrator.json');
  const mcpFile = join(dataDir, 'orchestrator-mcp.json');
  const queue = createKeyedQueue();

  const load = () => readJson(stateFile, { sessionId: null, cost: 0, turns: 0, updatedAt: null });
  const save = (s) => writeJsonAtomic(stateFile, { ...s, updatedAt: new Date().toISOString() });

  async function writeMcpConfig() {
    await mkdir(dataDir, { recursive: true });
    // ELECTRON_RUN_AS_NODE: inside the desktop app process.execPath is Electron, which then behaves as plain node.
    await writeJsonAtomic(mcpFile, {
      mcpServers: {
        board: { command: process.execPath, args: [MCP_SCRIPT], env: { AGENTCONTROL_URL: getBaseUrl(), AGENTCONTROL_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' } },
      },
    });
  }

  async function turn(prompt) {
    const s = await load();
    await writeMcpConfig();
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', mcpFile, '--strict-mcp-config',
      '--allowedTools', 'mcp__board',
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task',
      // The user's hooks, plugins and other MCP servers are not needed to steer the board, and loading them is slow.
      '--setting-sources', '', '--disable-slash-commands',
      '--append-system-prompt', SYSTEM_PROMPT,
    ];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    // Steps a tool refused until the person confirms them come back as confirmations; the page asks with a popup.
    const { result, tools, confirmations } = await runTurn({ claude, args, cwd: dataDir, sessionId: s.sessionId, prompt: () => prompt, collect: toolCollector('board') });
    ledger?.record('orchestrator', usageFromResult(result));
    if (result.is_error) throw Object.assign(new Error(`Ohjaaja epäonnistui: ${result.result ?? result.subtype ?? 'tuntematon virhe'}`), { expose: true });
    await save({ sessionId: result.session_id ?? s.sessionId, cost: Math.round((s.cost + (result.total_cost_usd ?? 0)) * 1e4) / 1e4, turns: s.turns + 1 });
    return { reply: String(result.result ?? '').trim(), tools, confirmations, cost: result.total_cost_usd ?? 0 };
  }

  /** One message from the person; `screen` says what they are looking at. */
  function send({ text, screen } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new ValidationError('text is required');
    if (text.length > MAX_TEXT) throw new ValidationError('text is too long');
    const prompt = `[Screen: ${String(screen ?? 'the board').slice(0, 1500)}]\n${text.trim()}`;
    return queue.run('orchestrator', async () => {
      log('ohjaaja', `Viesti ohjaajalle: ${text.trim()}`);
      try {
        const out = await turn(prompt);
        log('ohjaaja', `Ohjaaja${out.tools.length ? ` (${[...new Set(out.tools)].join(', ')})` : ''}: ${out.reply}`);
        return out;
      } catch (e) {
        log('ohjaaja', `Ohjaaja epäonnistui: ${e.message}`, { level: 'error' });
        throw e;
      }
    });
  }

  /** Forget the conversation: the next message starts a new session. */
  async function reset() {
    const s = await load();
    await save({ ...s, sessionId: null });
    return { reset: true };
  }

  return { send, reset, status: async () => ({ ...(await load()), busy: queue.busy('orchestrator') }) };
}

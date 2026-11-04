import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundError, ValidationError } from './cards.js';
import { checkImage } from './attachments.js';
import { createJournal } from './events.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { createKeyedQueue, runTurn, toolCollector } from './session.js';
import { usageFromResult } from './usage.js';

const MCP_SCRIPT = fileURLToPath(new URL('./sandbox-mcp.js', import.meta.url));
const MAX_TEXT = 4000;
const MAX_STROKES = 5000;
const MAX_POINTS = 200_000;
export const MAX_CANVAS_BODY = 8_000_000; // a drawing at the limits above, as JSON ("[0.1234,0.5678]," per point), with room to spare
const MAX_ARTIFACT = 300_000; // characters of a pasted or uploaded artifact
const MAP_CHARS = 6000; // how much of the code map the first message carries
const IMAGE_RE = /^canvas-(\d+)\.png$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

const systemPrompt = (name) => [
  `You are a brainstorming partner in the sandbox of the software project "${name}" in AgentControl, a kanban board where coding agents implement cards. The person thinks out loud with you about ideas, features and designs for this project.`,
  'You do not write code and never change files. You may read the project\'s code (Read, Grep, Glob) when it helps to ground an idea in how things are built now.',
  'The person also has a drawing canvas. You never see it live: a drawing reaches you only when they press "Näytä piirros tekoälylle", and then the message names a PNG file to look at with the Read tool. When asked about a drawing that was not shared, say that you cannot see it until they press that button.',
  'The person can also share artifacts (pages, documents, plans made elsewhere) as text: the message then names a file to read with the Read tool. Use them as the basis of the conversation, and propose cards from them with propose_card when asked. For Microsoft and Azure questions use the microsoft-learn tools (official docs). You can search the web (WebSearch) and read public pages (WebFetch) when it helps an idea, but pages that need a login, such as claude.ai artifacts, cannot be opened by you: ask the person to paste such a link in the chat of the AgentControl desktop app, which reads the artifact with their login and shares its text with you, or to paste the text.',
  'When an idea is ripe enough to build, propose a card with the propose_card tool (title and a description that stands on its own; attachCanvas when the shared drawing helps), one call per card. The person gets an OK popup for it, so do not ask in chat whether to create it. A popup is shown once: when they cancelled it, closed it or ask for the card again, call propose_card again instead of saying it still waits. A message may start with what they pressed in such popups.',
  'Reply in Finnish, short and plain.',
].join('\n');

function checkText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ValidationError('text is required');
  if (text.length > MAX_TEXT) throw new ValidationError('text is too long');
}

/**
 * A project's sandbox: a conversation with an AI about the project (one Claude session per project that lives across
 * messages, like the orchestrator) and a drawing canvas. Kept under data/sandbox/<project>/: state.json (session),
 * chat.jsonl, canvas.json (strokes, saved as they are drawn) and shared/canvas-<n>.png (each drawing shown to the AI).
 * Every entry point first looks the project up and from then on uses its own name, so "Foo" and "foo" (the same
 * folder on Windows) share one queue, chat log and session.
 */
export function createSandbox({ claude, dataDir, projects, explorer, store, attachments, model = 'sonnet', effort = null, ledger = null, log = () => {}, timeoutMs }) {
  const root = join(dataDir, 'sandbox');
  const queue = createKeyedQueue(); // each project's messages, one at a time
  const canvasQueue = createKeyedQueue(); // each project's canvas reads and writes, in order
  const chats = new Map();

  const dirOf = (name) => join(root, name);
  const sharedDir = (name) => join(dirOf(name), 'shared');
  const chatOf = (name) => {
    if (!chats.has(name)) chats.set(name, createJournal(join(dirOf(name), 'chat.jsonl'), { maxText: 20_000 }));
    return chats.get(name);
  };
  const loadState = (name) => readJson(join(dirOf(name), 'state.json'), { sessionId: null, cost: 0, turns: 0, updatedAt: null });
  const saveState = (name, s) => writeJsonAtomic(join(dirOf(name), 'state.json'), { ...s, updatedAt: new Date().toISOString() });
  const loadCanvas = (name) => readJson(join(dirOf(name), 'canvas.json'), { strokes: [], rev: 0 });

  /** The project, or NotFoundError: checked before a name ever becomes a path. */
  const project = (name) => projects.get(typeof name === 'string' ? name : '');

  // Reads go through the same queue as writes, so a read never returns a drawing older than a save made before it.
  const canvasWrite = (name, strokes) => canvasQueue.run(name, async () => {
    const cur = await loadCanvas(name);
    const out = { strokes, rev: cur.rev + 1, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(join(dirOf(name), 'canvas.json'), out);
    return { rev: out.rev, strokes: strokes.length };
  });

  async function getState(given) {
    const { name } = await project(given);
    const [chat, canvas, s] = await Promise.all([chatOf(name).tail(200), canvasQueue.run(name, () => loadCanvas(name)), loadState(name)]);
    return { chat, canvas, busy: queue.busy(name), turns: s.turns, cost: s.cost };
  }

  /** Saves the drawing as it is now. Only stores it: the AI sees a drawing only through share(). */
  async function saveCanvas(given, { strokes } = {}) {
    const { name } = await project(given);
    return canvasWrite(name, validStrokes(strokes));
  }

  async function clearCanvas(given) {
    const { name } = await project(given);
    return canvasWrite(name, []);
  }

  /** "Näytä piirros tekoälylle": the PNG goes to a file of its own, and the message asks the AI to read it. */
  async function share(given, { png, text, notes } = {}) {
    const p = await project(given);
    if (typeof png !== 'string' || !png) throw new ValidationError('png (base64) is required');
    const data = Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64');
    checkImage('png', data);
    const said = typeof text === 'string' && text.trim() ? text : 'Katso piirrostani.';
    checkText(said); // before the file is written, so a refused share leaves nothing behind
    const image = await saveShared(p.name, 'canvas', 'png', data);
    const path = realpathSync.native(join(sharedDir(p.name), image));
    return queueMessage(p, { text: said, notes }, { image, preamble: `[The person shared their canvas drawing: ${path}. Look at it with the Read tool.]` });
  }

  /** The next free shared/<prefix>-<n>.<ext>, written with 'wx' so two shares at once never write the same file. */
  async function saveShared(name, prefix, ext, data) {
    const dir = sharedDir(name);
    await mkdir(dir, { recursive: true });
    const re = new RegExp(`^${prefix}-(\\d+)\\.${ext}$`);
    let n = Math.max(0, ...(await readdir(dir)).map((f) => Number(f.match(re)?.[1] ?? 0))) + 1;
    for (;; n++) {
      try { await writeFile(join(dir, `${prefix}-${n}.${ext}`), data, { flag: 'wx' }); return `${prefix}-${n}.${ext}`; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }

  /**
   * "Liitä artifakti": the content of a page or document made elsewhere (an artifact on claude.ai cannot be opened from
   * here, so the person pastes or uploads it) goes to a file of its own, and the message asks the AI to read it.
   */
  async function shareArtifact(given, { content, title, text, notes } = {}) {
    const p = await project(given);
    if (typeof content !== 'string' || !content.trim()) throw new ValidationError('content is required');
    if (content.length > MAX_ARTIFACT) throw new ValidationError('artifact is too long');
    const label = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Artifakti';
    const said = typeof text === 'string' && text.trim() ? text : `Katso liittämääni artifaktia: ${label}.`;
    checkText(said);
    const artifact = await saveShared(p.name, 'artifact', 'txt', content);
    const path = realpathSync.native(join(sharedDir(p.name), artifact));
    return queueMessage(p, { text: said, notes }, { artifact: { file: artifact, title: label }, preamble: `[The person shared an artifact titled "${label}" (${content.length} characters): ${path}. Read it with the Read tool before you answer.]` });
  }

  async function readImage(given, image) {
    const { name } = await project(given);
    if (!IMAGE_RE.test(String(image))) throw new NotFoundError(`Image ${image} not found`);
    try {
      return await readFile(join(sharedDir(name), image));
    } catch (e) {
      if (e.code === 'ENOENT') throw new NotFoundError(`Image ${image} not found`);
      throw e;
    }
  }

  async function writeMcpConfig(name) {
    const file = join(dirOf(name), 'mcp.json');
    // ELECTRON_RUN_AS_NODE: inside the desktop app process.execPath is Electron, which then behaves as plain node.
    await writeJsonAtomic(file, { mcpServers: {
      sandbox: { command: process.execPath, args: [MCP_SCRIPT], env: { ELECTRON_RUN_AS_NODE: '1' } },
      'microsoft-learn': { type: 'http', url: 'https://learn.microsoft.com/api/mcp' }, // Microsoft's public docs search; no login
    } });
    return file;
  }

  async function turn(p, message) {
    const name = p.name;
    const s = await loadState(name);
    await mkdir(dirOf(name), { recursive: true });
    const members = (p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }]).map((m) => realpathSync.native(m.path));
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', await writeMcpConfig(name), '--strict-mcp-config',
      '--allowedTools', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'mcp__sandbox', 'mcp__microsoft-learn',
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Task',
      // The user's hooks, plugins and other MCP servers are not needed to talk about a project, and loading them is slow.
      '--setting-sources', '', '--disable-slash-commands',
      '--append-system-prompt', systemPrompt(name),
    ];
    for (const dir of [realpathSync.native(dirOf(name)), ...members]) args.push('--add-dir', dir);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    // A new session gets the project's code map once; later messages only say which project this is.
    const prompt = async (fresh) => {
      const map = fresh ? await explorer.mapOf(name).catch(() => null) : null;
      const mapText = map ? `\n## Code map of this project (written earlier by an explorer; it can lag behind the code)\n\n${map.text.length > MAP_CHARS ? `${map.text.slice(0, MAP_CHARS)}…` : map.text}\n` : '';
      return [`[Project: ${name}, repository ${members.join(', ')}]${mapText}`, message].join('\n');
    };
    // The cards the AI proposed come back as confirmations; the page asks with a popup.
    const { result, tools, confirmations } = await runTurn({ claude, args, cwd: members[0], sessionId: s.sessionId, prompt, collect: toolCollector('sandbox'), timeoutMs });
    ledger?.record('sandbox', usageFromResult(result), { project: name });
    if (result.is_error) throw Object.assign(new Error(`Sandbox epäonnistui: ${result.result ?? result.subtype ?? 'tuntematon virhe'}`), { expose: true });
    await saveState(name, { sessionId: result.session_id ?? s.sessionId, cost: Math.round((s.cost + (result.total_cost_usd ?? 0)) * 1e4) / 1e4, turns: s.turns + 1 });
    return { reply: String(result.result ?? '').trim(), tools, confirmations: confirmations.filter((c) => c.tool === 'propose_card'), cost: result.total_cost_usd ?? 0 };
  }

  /** Logs the person's message, queues its turn, and logs the reply (or the failure) when it comes. */
  function queueMessage(p, { text, notes }, { image = null, artifact = null, preamble = '' } = {}) {
    const name = p.name;
    if (typeof notes === 'string' && notes.trim()) preamble = [`[Popups since your last reply: ${notes.trim().slice(0, 1000)}]`, preamble].filter(Boolean).join('\n');
    const chat = chatOf(name);
    chat.add({ who: 'me', text: text.trim(), ...(image ? { image } : {}), ...(artifact ? { artifact } : {}) });
    return queue.run(name, async () => {
      log('sandbox', `Sandbox ${name}: ${image ? `piirros jaettu (${image}): ` : ''}${artifact ? `artifakti jaettu (${artifact.file}): ` : ''}${text.trim()}`, { project: name });
      try {
        const out = await turn(p, [preamble, text.trim()].filter(Boolean).join('\n'));
        chat.add({ who: 'bot', text: out.reply || '(ei vastausta)' });
        log('sandbox', `Sandbox ${name}${out.tools.length ? ` (${[...new Set(out.tools)].join(', ')})` : ''}: ${out.reply}`, { project: name });
        return out;
      } catch (e) {
        chat.add({ who: 'bot', text: `Sandbox ei vastannut: ${e.message}`, error: true });
        log('sandbox', `Sandbox ${name} epäonnistui: ${e.message}`, { project: name, level: 'error' });
        throw e;
      }
    });
  }

  /**
   * One message from the person. Both it and the reply go to the project's chat log here, so the page only shows them.
   * `notes` (what they pressed in the card popups since the last reply) goes to the AI but not to the log.
   */
  async function send(given, { text, notes } = {}) {
    const p = await project(given);
    checkText(text);
    return queueMessage(p, { text, notes });
  }

  /** Forget the conversation: the next message starts a new session. The chat log keeps a divider. */
  async function reset(given) {
    const { name } = await project(given);
    await mkdir(dirOf(name), { recursive: true });
    await saveState(name, { ...(await loadState(name)), sessionId: null });
    chatOf(name).add({ who: 'bot', text: '— uusi keskustelu —', sep: true });
    return { reset: true };
  }

  /**
   * A card from the sandbox, made only by the person (the button, or OK in the popup for a proposal). The image is
   * checked before the card exists; should attaching it still fail, the card stands (with `attachError`), so trying
   * again never makes a second card.
   */
  async function createCard(given, { title, description, image } = {}) {
    const p = await project(given);
    let data = null;
    if (image != null && image !== '') {
      data = await readImage(p.name, image);
      checkImage('png', data);
    }
    const card = await store.create({ title, brief: description, repos: p.workspace ? p.workspaceRepos.map((r) => r.name) : [p.name] });
    let attachError = null;
    if (data) {
      try { await attachments.add(card.id, 'image/png', data); } catch (e) {
        attachError = e.message;
        log('sandbox', `Sandbox ${p.name}: piirroksen liittäminen korttiin epäonnistui: ${e.message}`, { project: p.name, card: card.id, level: 'error' });
      }
    }
    log('sandbox', `Sandbox ${p.name}: kortti luotu: ${card.title}${data && !attachError ? ' (piirros liitetty)' : ''}`, { project: p.name, card: card.id });
    return attachError ? { ...card, attachError } : card;
  }

  return { getState, saveCanvas, clearCanvas, share, shareArtifact, readImage, send, reset, createCard, dirOf };
}

/** Strokes as the page draws them: { color, width, erase?, points: [[x, y], …] } with x and y as fractions of the canvas. */
function validStrokes(strokes) {
  if (!Array.isArray(strokes)) throw new ValidationError('strokes must be an array');
  if (strokes.length > MAX_STROKES) throw new ValidationError(`at most ${MAX_STROKES} strokes`);
  let points = 0;
  return strokes.map((s) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.points)) throw new ValidationError('each stroke needs points');
    if (typeof s.color !== 'string' || !COLOR_RE.test(s.color)) throw new ValidationError('stroke color must be #rgb');
    if (typeof s.width !== 'number' || !(s.width >= 0.5 && s.width <= 100)) throw new ValidationError('stroke width must be 0.5..100');
    points += s.points.length;
    if (points > MAX_POINTS) throw new ValidationError(`at most ${MAX_POINTS} points`);
    for (const pt of s.points) {
      if (!Array.isArray(pt) || pt.length !== 2 || !pt.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 2)) throw new ValidationError('points must be [x, y] fractions');
    }
    return { color: s.color, width: s.width, ...(s.erase === true ? { erase: true } : {}), points: s.points.map(([x, y]) => [x, y]) };
  });
}

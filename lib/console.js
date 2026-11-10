import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectDirName } from './usage.js';

const BACKLOG_BYTES = 512 * 1024; // how far back a newly opened console reads an agent's transcript
const MAX_TEXT = 4000;            // one entry's text; the transcript keeps the rest
const MAX_OUTPUT = 600;           // a tool's output is only a glimpse: the agent's own reply says what it made of it

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}… (+${t.length - n} merkkiä)` : t;
};

/** What a tool call is about in one line: the command, the file, the pattern or the address. */
export function toolSummary(name, input = {}) {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt
    ?? Object.values(input).find((v) => typeof v === 'string') ?? '';
  return clip(String(pick).replace(/\s+/g, ' ').trim(), 300);
}

/**
 * The lines of a Claude Code session transcript (~/.claude/projects/<folder>/<session>.jsonl) as console entries:
 * { t, kind, ... } with kind text (the agent speaks), thinking, tool (a call: name + summary), output (what the
 * tool gave back, clipped) and user (a prompt or reply sent to the agent). Bookkeeping lines give nothing.
 * Thinking that the API returned redacted (empty with only a signature) is left out.
 */
export function transcriptEntries(e) {
  const t = e?.timestamp ?? null;
  const sub = e?.isSidechain ? { sub: true } : {}; // a sub-agent's line
  const content = e?.message?.content;
  if (e?.type === 'assistant' && Array.isArray(content)) {
    return content.flatMap((b) => {
      if (b.type === 'text' && b.text?.trim()) return [{ t, kind: 'text', text: clip(b.text, MAX_TEXT), ...sub }];
      if (b.type === 'thinking' && b.thinking?.trim()) return [{ t, kind: 'thinking', text: clip(b.thinking, MAX_TEXT), ...sub }];
      if (b.type === 'tool_use') return [{ t, kind: 'tool', name: b.name, summary: toolSummary(b.name, b.input), ...sub }];
      return [];
    });
  }
  if (e?.type === 'user') {
    if (typeof content === 'string') return content.trim() ? [{ t, kind: 'user', text: clip(content, MAX_TEXT), ...sub }] : [];
    if (!Array.isArray(content)) return [];
    return content.flatMap((b) => {
      if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '');
        return [{ t, kind: 'output', text: clip(text.trim(), MAX_OUTPUT), error: b.is_error === true, ...sub }];
      }
      if (b.type === 'text' && b.text?.trim()) return [{ t, kind: 'user', text: clip(b.text, MAX_TEXT), ...sub }];
      return [];
    });
  }
  return [];
}

const parseLines = (text) => text.split('\n').flatMap((l) => {
  if (!l.trim()) return [];
  try { return transcriptEntries(JSON.parse(l)); } catch { return []; }
});

/**
 * The live console: who works right now (implementation and research agents, refiners mid-turn) and, as it
 * happens, what each one says, thinks and runs. Background agents are read from their session transcripts, the
 * same record `claude attach` shows; refiners from their live stream. Nothing runs while nobody watches: the
 * transcripts are polled only while a console is open.
 *
 * `subscribe(fn, { card })` gets { type: 'workers', workers } when the set changes and { type: 'entry', key, entry }
 * for each new line; `card` limits it to one card's agent (its refiner is streamed by the card view already).
 */
export function createAgentConsole({ store, runner, refiner, claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), pollMs = 1000, backlog = 120 }) {
  const projectsDir = join(claudeDir, 'projects');
  const subscribers = new Set(); // { fn, card }
  const tails = new Map();       // worker key -> { file, offset, sessionId }
  const scanned = new Map();     // session id -> when the folders were last searched without luck
  let workers = [];
  let workersJson = '';
  let timer = null;
  let polling = false;
  let unsubscribeRefiner = null;

  const found = new Map();       // session id -> its transcript file
  function locate(sessionId, cwd) {
    if (!sessionId) return null;
    if (found.has(sessionId) && existsSync(found.get(sessionId))) return found.get(sessionId);
    const keep = (f) => { found.set(sessionId, f); return f; };
    const direct = cwd ? join(projectsDir, projectDirName(cwd), `${sessionId}.jsonl`) : null;
    if (direct && existsSync(direct)) return keep(direct);
    // Claude Code may name the folder after another spelling of the path (e.g. a short 8.3 name): look everywhere, now and then.
    if (Date.now() - (scanned.get(sessionId) ?? 0) < 30_000) return null;
    scanned.set(sessionId, Date.now());
    try {
      for (const d of readdirSync(projectsDir)) {
        const f = join(projectsDir, d, `${sessionId}.jsonl`);
        if (existsSync(f)) return keep(f);
      }
    } catch { /* no projects folder yet */ }
    return null;
  }

  const realCwd = (run) => {
    const p = run.worktrees?.[0]?.path ?? run.cwd;
    if (!p) return null;
    try { return realpathSync.native(p); } catch { return p; }
  };

  /** Who works now. Cheap: card files are cached, run.json is small, and `claude agents` is not called again. */
  async function listWorkers() {
    const cards = await store.list();
    const entries = runner.agentEntries?.() ?? [];
    const busyRefining = new Set(refiner?.busy?.() ?? []);
    const out = [];
    for (const c of cards) {
      if (busyRefining.has(c.id)) out.push({ key: `refine:${c.id}`, card: c.id, title: c.title, kind: 'refine', state: 'running' });
      if (c.status !== 'running' && c.status !== 'needs_input') continue;
      const run = await runner.run(c.id).catch(() => null);
      if (!run?.agentId || !['running', 'needs_input', 'reviewing'].includes(run.state)) continue;
      const entry = entries.find((a) => a.id === run.agentId);
      out.push({
        key: `agent:${c.id}`, card: c.id, title: c.title, kind: run.kind === 'research' ? 'research' : 'agent',
        agentId: run.agentId, sessionId: entry?.sessionId ?? run.sessionId ?? null, cwd: realCwd(run),
        state: run.state, waitingFor: run.waitingFor ?? null, startedAt: run.startedAt ?? null,
        model: run.model ?? null,
      });
    }
    return out;
  }

  const publicWorker = ({ sessionId, cwd, ...w }) => w;

  function emit(msg, card = null) {
    for (const s of subscribers) {
      if (s.card && s.card !== card) continue;
      try { s.fn(msg); } catch { /* a closed connection: it unsubscribes itself */ }
    }
  }

  /** Reads what the agent's transcript gained since the last look. The first look starts at its end. */
  async function readNew(w) {
    let tail = tails.get(w.key);
    if (!tail || tail.sessionId !== w.sessionId) {
      const file = locate(w.sessionId, w.cwd);
      if (!file) return [];
      tail = { file, sessionId: w.sessionId, offset: (await stat(file)).size };
      tails.set(w.key, tail);
      return [];
    }
    const size = await stat(tail.file).then((s) => s.size, () => 0);
    if (size < tail.offset) tail.offset = 0; // replaced
    if (size === tail.offset) return [];
    const fh = await open(tail.file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(size - tail.offset);
      await fh.read(buf, 0, buf.length, tail.offset);
    } finally { await fh.close(); }
    const end = buf.lastIndexOf(0x0a) + 1; // a half-written last line waits for the next look
    if (!end) return [];
    tail.offset += end;
    return parseLines(buf.subarray(0, end).toString('utf8'));
  }

  /** The last `backlog` entries of an agent's transcript, for a console that just opened. */
  async function agentBacklog(w) {
    const file = locate(w.sessionId, w.cwd);
    if (!file) return [];
    const size = (await stat(file)).size;
    const from = Math.max(0, size - BACKLOG_BYTES);
    const fh = await open(file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(size - from);
      await fh.read(buf, 0, buf.length, from);
    } finally { await fh.close(); }
    let text = buf.toString('utf8');
    if (from > 0) text = text.slice(text.indexOf('\n') + 1); // the first line was cut
    return parseLines(text).slice(-backlog);
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      workers = await listWorkers();
      const json = JSON.stringify(workers.map(publicWorker));
      if (json !== workersJson) {
        workersJson = json;
        emit({ type: 'workers', workers: workers.map(publicWorker) });
      }
      for (const key of tails.keys()) if (!workers.some((w) => w.key === key)) tails.delete(key);
      for (const w of workers.filter((x) => x.kind !== 'refine')) {
        const entries = await readNew(w).catch(() => []);
        for (const entry of entries) emit({ type: 'entry', key: w.key, entry }, w.card);
      }
    } catch (e) {
      console.error('console poll:', e.message);
    } finally {
      polling = false;
    }
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(poll, pollMs);
    unsubscribeRefiner = refiner?.subscribeAll?.((id, line) => emit({ type: 'entry', key: `refine:${id}`, entry: line }, null)) ?? null;
  }
  function stopPolling() {
    clearInterval(timer);
    timer = null;
    unsubscribeRefiner?.();
    unsubscribeRefiner = null;
    tails.clear();
  }

  /**
   * Starts a feed: first the workers and each one's recent entries (`snapshot`), then live messages to `fn`.
   * Returns the unsubscribe. With `card`, only that card's agent.
   */
  async function subscribe(fn, { card = null } = {}) {
    const sub = { fn, card };
    // Read the current state before going live, so the first poll after it only adds what is new.
    workers = await listWorkers();
    workersJson = JSON.stringify(workers.map(publicWorker));
    const mine = workers.filter((w) => !card || (w.card === card && w.kind !== 'refine'));
    if (!card) fn({ type: 'workers', workers: mine.map(publicWorker) });
    for (const w of mine) {
      const entries = w.kind === 'refine' ? await refiner.liveTail(w.card, backlog).catch(() => []) : await agentBacklog(w).catch(() => []);
      fn({ type: 'backlog', key: w.key, entries });
      if (w.kind !== 'refine' && !tails.has(w.key)) {
        const file = locate(w.sessionId, w.cwd);
        if (file) tails.set(w.key, { file, sessionId: w.sessionId, offset: (await stat(file)).size });
      }
    }
    subscribers.add(sub);
    startPolling();
    return () => {
      subscribers.delete(sub);
      if (!subscribers.size) stopPolling();
    };
  }

  return { subscribe, workers: async () => (await listWorkers()).map(publicWorker), poll, shutdown: stopPolling };
}

import { existsSync, readdirSync } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendRotating } from './events.js';
import { readJson, writeJsonAtomic } from './fsutil.js';

/**
 * Token accounting. Everything is counted in tokens, never in money (the work runs on a subscription).
 * A usage is { input, output, cacheRead, cacheWrite }: `input` and `output` are the fresh tokens, the cache fields
 * the prompt cache's share, which is large and cheap and so kept apart.
 *
 * Every spend is one line in data/usage.jsonl: { t, kind, card?, project?, ...usage }. kind is one of
 * agent | review | refine | planner | explore | audit | orchestrator | voice. Headless runs report their usage in the `result` event;
 * background agents only in their session transcript, which `createTranscriptReader` reads incrementally.
 */
export const KINDS = ['agent', 'review', 'refine', 'planner', 'explore', 'audit', 'orchestrator', 'voice'];
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const isEmptyUsage = (u) => FIELDS.every((f) => !u?.[f]);
export const addUsage = (a, b) => Object.fromEntries(FIELDS.map((f) => [f, (a?.[f] ?? 0) + (b?.[f] ?? 0)]));
export const totalTokens = (u) => (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0);

/** The usage block of a claude `result` event (or a transcript message) in our field names. */
export function usageFromApi(u) {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  };
}
export const usageFromResult = (result) => usageFromApi(result?.usage);

/** Appends spends to the ledger and summarizes it. `record` never throws: losing a line must not break the work. */
export function createUsageLedger(dataDir, { now = () => new Date() } = {}) {
  const file = join(dataDir, 'usage.jsonl');
  let queue = Promise.resolve();

  function record(kind, usage, { card = null, project = null } = {}) {
    if (!usage || isEmptyUsage(usage)) return;
    const line = { t: now().toISOString(), kind, ...(card ? { card } : {}), ...(project ? { project } : {}), ...Object.fromEntries(FIELDS.map((f) => [f, usage[f] ?? 0])) };
    queue = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendRotating(file, `${JSON.stringify(line)}\n`);
    }).catch(() => {});
  }

  async function lines() {
    await queue;
    const read = (f) => readFile(f, 'utf8').then((s) => s.split('\n').filter(Boolean), () => []);
    const all = [...await read(file.replace(/\.jsonl$/, '.1.jsonl')), ...await read(file)];
    return all.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }

  /**
   * Totals overall, per day (local date, last `days`), per kind, per card and per project.
   * `today` and the day keys use the local calendar, so "today" matches the person's clock.
   */
  async function summary({ days = 14 } = {}) {
    const total = emptyUsage();
    const byKind = {}, byCard = {}, byProject = {}, byDay = {};
    const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const add = (map, key, u) => { map[key] = addUsage(map[key], u); };
    for (const e of await lines()) {
      Object.assign(total, addUsage(total, e));
      add(byKind, e.kind, e);
      if (e.card) add(byCard, e.card, e);
      if (e.project) add(byProject, e.project, e);
      add(byDay, day(e.t), e);
    }
    const keys = Object.keys(byDay).sort().slice(-days);
    return { total, today: byDay[day(now())] ?? emptyUsage(), byKind, byCard, byProject, byDay: keys.map((d) => ({ day: d, ...byDay[d] })) };
  }

  return { record, summary, file };
}

export const projectDirName = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-'); // how Claude Code names a folder's transcript directory

/**
 * Reads what a background agent has spent, from its session transcript (~/.claude/projects/<folder>/<session>.jsonl).
 * Only the part appended since the last call is read. A reply is written in several lines that repeat the same
 * message id with growing counts, and a resumed session may carry earlier messages along, so each message id is
 * counted once, at its largest value. The bookkeeping lives in `<cardDir>/usage.json`.
 */
export function createTranscriptReader({ claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), scanEveryMs = 60_000 } = {}) {
  const projectsDir = join(claudeDir, 'projects');
  const lastScan = new Map(); // session id -> when the folders were last searched for it without luck

  function locate(sessionId, cwd) {
    const direct = cwd ? join(projectsDir, projectDirName(cwd), `${sessionId}.jsonl`) : null;
    if (direct && existsSync(direct)) return direct;
    if (Date.now() - (lastScan.get(sessionId) ?? 0) < scanEveryMs) return null;
    lastScan.set(sessionId, Date.now());
    try {
      for (const d of readdirSync(projectsDir)) {
        const f = join(projectsDir, d, `${sessionId}.jsonl`);
        if (existsSync(f)) return f;
      }
    } catch { /* no projects folder yet */ }
    return null;
  }

  /** The usage added since the last call for this card (zeros when nothing is new or the transcript is not there). */
  async function collect(cardDir, { sessionId, cwd }) {
    const delta = emptyUsage();
    if (!sessionId) return delta;
    const stateFile = join(cardDir, 'usage.json');
    const state = await readJson(stateFile, { sessions: {}, msgs: {} }).catch(() => ({ sessions: {}, msgs: {} }));
    const sess = state.sessions[sessionId] ??= { file: null, offset: 0 };
    if (!sess.file || !existsSync(sess.file)) sess.file = locate(sessionId, cwd);
    if (!sess.file) return delta;
    const size = (await stat(sess.file)).size;
    if (size < sess.offset) sess.offset = 0; // the file was replaced; message ids keep the counting honest
    if (size === sess.offset) return delta;

    const fh = await open(sess.file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(size - sess.offset);
      await fh.read(buf, 0, buf.length, sess.offset);
    } finally { await fh.close(); }
    const end = buf.lastIndexOf(0x0a) + 1; // a half-written last line waits for the next call
    if (!end) return delta;
    sess.offset += end;

    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const id = entry.message?.id;
      if (entry.type !== 'assistant' || !id || !entry.message.usage) continue;
      const u = usageFromApi(entry.message.usage);
      const seen = state.msgs[id] ?? emptyUsage();
      for (const f of FIELDS) {
        if (u[f] > seen[f]) { delta[f] += u[f] - seen[f]; seen[f] = u[f]; }
      }
      state.msgs[id] = seen;
    }
    await writeJsonAtomic(stateFile, state);
    return delta;
  }

  return { collect };
}

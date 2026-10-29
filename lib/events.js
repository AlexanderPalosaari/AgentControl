import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024; // then the file becomes <name>.1.jsonl and a new one starts
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

/** Appends a line to a JSONL file, first moving it to <name>.1.jsonl when it has grown past `maxBytes`. */
export async function appendRotating(file, line, maxBytes = MAX_BYTES) {
  const size = await stat(file).then((s) => s.size, () => 0);
  if (size > maxBytes) await rename(file, file.replace(/\.jsonl$/, '.1.jsonl')).catch(() => {});
  await appendFile(file, line, 'utf8');
}

/**
 * An append-only JSONL journal on disk (so it survives restarts) with live subscribers (for the log stream).
 * Entries: { t, kind, text, card?, project?, level? }. Writes are queued, so lines never interleave.
 * With `collapseMs`, an error that repeats within that time of the same error (a broken command retried every few
 * seconds) is not written again; the next other entry is preceded by one line saying how often it repeated.
 */
export function createJournal(file, { maxBytes = MAX_BYTES, maxText = 4000, collapseMs = 0 } = {}) {
  const subscribers = new Set();
  let queue = mkdir(dirname(file), { recursive: true }).catch(() => {});
  let repeat = null; // { key, since, count, entry }

  function emit(line) {
    queue = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendRotating(file, `${JSON.stringify(line)}\n`, maxBytes);
    }).catch(() => {}); // a full disk must never break the app; the line still goes to live subscribers
    for (const fn of subscribers) { try { fn(line); } catch { /* one bad subscriber must not stop the rest */ } }
    return line;
  }

  function flushRepeat() {
    if (repeat?.count) emit({ ...repeat.entry, t: new Date().toISOString(), text: clip(`${repeat.entry.text} (toistui ${repeat.count} kertaa)`, maxText) });
    repeat = null;
  }

  function add(entry) {
    const line = { t: new Date().toISOString(), ...entry, text: clip(entry.text, maxText) };
    if (collapseMs && line.level === 'error') {
      const key = `${line.kind}|${line.card ?? ''}|${line.project ?? ''}|${line.text}`;
      if (repeat?.key === key && Date.now() - repeat.since < collapseMs) { repeat.count++; return line; }
      flushRepeat();
      repeat = { key, since: Date.now(), count: 0, entry: line };
    } else {
      flushRepeat();
    }
    return emit(line);
  }

  /** The last `limit` entries (from the current file, and the rotated one when needed). */
  async function tail(limit = 200) {
    await queue;
    const read = (f) => readFile(f, 'utf8').then((s) => s.split('\n').filter(Boolean), () => []);
    let lines = await read(file);
    if (lines.length < limit) lines = [...(await read(file.replace(/\.jsonl$/, '.1.jsonl'))), ...lines];
    return lines.slice(-limit).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }

  const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
  return { add, tail, subscribe, flushed: () => queue };
}

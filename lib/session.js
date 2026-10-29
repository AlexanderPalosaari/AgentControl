// What the orchestrator and the project sandboxes share: one headless Claude session that lives across messages
// (--resume), handled one message at a time.

export const TURN_TIMEOUT_MS = 10 * 60_000;
const GONE_RE = /No conversation found with session ID/i;

/**
 * Whether a run failed because the session to resume no longer exists (cleaned up, or made on another machine).
 * The CLI says so in an error result (exit 0); a thrown error carries its stderr in the message.
 */
export function sessionGone(x) {
  if (x instanceof Error) return GONE_RE.test(x.message);
  return Boolean(x?.is_error) && GONE_RE.test([...(x.errors ?? []), x.result ?? ''].join('\n'));
}

/**
 * One turn of a resumable session. `prompt(fresh)` gives the message (a new session may need more context), and
 * `collect()` a fresh { onEvent, ... } for each attempt, so a dropped attempt leaves nothing behind. Only a session
 * that is gone is replaced by a new one: any other failure is thrown, and the conversation is kept for the next try.
 * A run that takes longer than `timeoutMs` is stopped, so a hung process never blocks the queue for good.
 */
export async function runTurn({ claude, args, cwd, sessionId, prompt, collect, timeoutMs = TURN_TIMEOUT_MS }) {
  const attempt = async (id) => {
    const out = collect();
    try {
      const result = await claude.run({ args: id ? [...args, '--resume', id] : args, cwd, prompt: await prompt(!id), onEvent: out.onEvent, signal: AbortSignal.timeout(timeoutMs) });
      return { ...out, result };
    } catch (e) {
      if (e.aborted) throw Object.assign(new Error(`ei vastausta ${Math.round(timeoutMs / 60_000)} minuutissa, ajo pysäytettiin`), { expose: true });
      throw e;
    }
  };
  if (!sessionId) return attempt(null);
  let first;
  try {
    first = await attempt(sessionId);
  } catch (e) {
    if (!sessionGone(e)) throw e;
    return attempt(null);
  }
  return sessionGone(first.result) ? attempt(null) : first;
}

/** Work queued per key: one job at a time for each key, in order; `busy(key)` while one runs. */
export function createKeyedQueue() {
  const tails = new Map();
  const running = new Set();
  function run(key, job) {
    const next = (tails.get(key) ?? Promise.resolve()).then(async () => {
      running.add(key);
      try { return await job(); } finally { running.delete(key); }
    });
    tails.set(key, next.catch(() => {}));
    return next;
  }
  return { run, busy: (key) => running.has(key) };
}

/** Adds the NEEDS_CONFIRMATION steps in a stream-json event's tool results to `confirmations` (each step once). */
export function collectConfirmations(e, confirmations) {
  if (e.type !== 'user') return;
  for (const b of e.message?.content ?? []) {
    if (b.type !== 'tool_result') continue;
    const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('');
    const m = text.match(/^NEEDS_CONFIRMATION (\{.*\})$/m);
    if (!m) continue;
    try {
      const c = JSON.parse(m[1]);
      if (!confirmations.some((x) => x.tool === c.tool && JSON.stringify(x.args) === JSON.stringify(c.args))) confirmations.push(c);
    } catch { /* not ours */ }
  }
}

/** A `collect` for runTurn: the tools used (named without `mcp__<server>__`) and the steps waiting for the person's OK. */
export function toolCollector(server) {
  return () => {
    const tools = [];
    const confirmations = [];
    const onEvent = (e) => {
      for (const b of e.message?.content ?? []) {
        if (e.type === 'assistant' && b.type === 'tool_use') tools.push(b.name.replace(new RegExp(`^mcp__${server}__`), ''));
      }
      collectConfirmations(e, confirmations);
    };
    return { onEvent, tools, confirmations };
  };
}

import { existsSync, realpathSync } from 'node:fs';
import { imagesSection } from './attachments.js';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfirmationError, ValidationError, unmetDependency } from './cards.js';
import { appendRotating } from './events.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { baseRef, git, resolveBase } from './git.js';
import { createRepos } from './repos.js';
import { addUsage, usageFromResult } from './usage.js';

const LIVE_MAX_BYTES = 2 * 1024 * 1024; // a card's live stream: then live.1.jsonl and a new live.jsonl

export const REFINE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One-line summary of the ticket as you understand it' },
    questions: {
      type: 'array',
      description: 'Open questions for the person. Empty when nothing blocks the plan.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short stable id such as q1' },
          text: { type: 'string' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, description: { type: 'string' } },
              required: ['label'],
            },
          },
          recommended: { type: 'string', description: 'The label of the option you recommend' },
        },
        required: ['id', 'text', 'options', 'recommended'],
      },
    },
    plan: { type: 'string', description: 'Implementation plan in Markdown: files to touch, steps, tests, risks, and a final "## Verification" section' },
    ready: { type: 'boolean', description: 'True only when there are no open questions and the plan can be implemented as written' },
  },
  required: ['summary', 'questions', 'plan', 'ready'],
};

const SYSTEM_PROMPT = [
  'You are the refiner in a ticket pipeline. You never change anything: you only read code and think.',
  'Read the relevant code before asking anything; do not ask what the code already answers.',
  'Ask only questions whose answer changes the plan. Give each question 2-4 options and mark one as recommended.',
  'Write the plan so another engineer who has not seen this conversation could implement it: concrete files, steps, tests, risks.',
  'End the plan with a "## Verification" section: which API calls to make and which browser flows to click through to prove the feature works, or for each kind of check you leave out (API, browser, automated tests) a concrete reason why it does not apply to this change. "Not needed" without a reason is not acceptable.',
  'Set ready=true only when there are no open questions left. Write in the language of the ticket.',
  'Your final reply must be the structured output and nothing else.',
].join('\n');

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)'];
const BLOCKED_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/**
 * `model` / `effort` are the defaults; the project of the card's first repository (`projectSettings`) overrides
 * them, and the card's own choice overrides both.
 * A repository whose card (or project, `projectBase`) chose a base branch is read from a checkout of that branch
 * under `checkoutsDir`, so the plan is made against the code the work will start from; without a base branch, or
 * without `checkoutsDir`, the refiner reads the repository folder as it is.
 */
export function createRefiner({ store, claude, reposRoot, repos = createRepos({ reposRoot }), model = null, effort = null, projectSettings = async () => ({}), projectContext = async () => null, projectBase = async () => null, checkoutsDir = null, attachments = null, ledger = null, log = () => {} }) {
  const running = new Set();
  const subscribers = new Map();

  const stateFile = (id) => join(store.dir(id), 'refine.json');
  const liveFile = (id) => join(store.dir(id), 'live.jsonl');
  const defaultState = () => ({
    state: 'idle', sessionId: null, turn: 0, summary: '', questions: [], plan: '', ready: false,
    history: [], cost: 0, error: null, pendingPrompt: null, updatedAt: null,
  });

  const load = (id) => readJson(stateFile(id), defaultState());
  const save = (id, s) => { s.updatedAt = new Date().toISOString(); return writeJsonAtomic(stateFile(id), s); };

  function repoPaths(card) {
    return card.repos.map((name) => {
      const path = repos.path(name);
      if (!existsSync(path)) throw new ValidationError(`Repo not found: ${path}`);
      return path;
    });
  }

  /**
   * Where the refiner reads each repository of the card: { repo, path, ref }. With a base branch that is a detached
   * checkout of it as on origin (ref), made or moved there now; else the repository folder as it is (ref null).
   * A repository once read from a checkout keeps it (on the default branch if the base was cleared), so the
   * refiner's session keeps the folders it knows.
   */
  async function readingDirs(id, card, s) {
    const out = [];
    for (const name of card.repos) {
      const repoPath = repos.path(name);
      const branch = card.baseBranch ?? await projectBase(name);
      const path = checkoutsDir && join(checkoutsDir, id, name);
      if (!path || (!branch && !s.checkouts?.includes(name))) {
        out.push({ repo: name, path: repoPath, ref: null });
        continue;
      }
      await git(['fetch', 'origin', '--quiet'], repoPath).catch(() => {}); // offline or no origin: as of the last fetch
      const ref = branch ? await resolveBase(repoPath, branch, { fetch: false }) : await baseRef(repoPath);
      if (existsSync(path)) {
        await git(['checkout', '--quiet', '--force', '--detach', ref], path); // the refiner never writes, so nothing of anyone's is lost
      } else {
        await mkdir(dirname(path), { recursive: true });
        await git(['worktree', 'prune'], repoPath).catch(() => {}); // a folder deleted by hand still counts as registered
        await git(['worktree', 'add', '--quiet', '--detach', path, ref], repoPath);
      }
      s.checkouts = [...new Set([...(s.checkouts ?? []), name])];
      out.push({ repo: name, path, ref });
    }
    return out;
  }

  /** Removes the card's refining checkouts: once its plan is approved, or when it left refining while the server was down. */
  async function removeCheckouts(id) {
    if (!checkoutsDir) return;
    const dir = join(checkoutsDir, id);
    for (const name of await readdir(dir).catch(() => [])) {
      const repoPath = (() => { try { return repos.path(name); } catch { return null; } })();
      if (repoPath) await git(['worktree', 'remove', '--force', join(dir, name)], repoPath).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  }

  async function emit(id, entry) {
    const line = { t: new Date().toISOString(), ...entry };
    await appendRotating(liveFile(id), JSON.stringify(line) + '\n', LIVE_MAX_BYTES).catch(() => {});
    for (const fn of subscribers.get(id) ?? []) fn(line);
  }

  function toLive(event) {
    if (event.type === 'assistant') {
      return (event.message?.content ?? []).flatMap((b) => {
        if (b.type === 'text' && b.text?.trim()) return [{ kind: 'text', text: b.text }];
        if (b.type === 'tool_use' && b.name !== 'StructuredOutput') {
          const first = Object.values(b.input ?? {}).find((v) => typeof v === 'string') ?? '';
          return [{ kind: 'tool', name: b.name, summary: first.slice(0, 200) }];
        }
        return [];
      });
    }
    if (event.type === 'result') return [{ kind: 'result', ok: !event.is_error, cost: event.total_cost_usd ?? 0 }];
    return [];
  }

  async function runTurn(id, prompt) {
    if (running.has(id)) throw new ValidationError('Refinement is already running for this card');
    running.add(id);
    try {
      const card = await store.get(id);
      const repos = repoPaths(card);

      const s = await load(id);
      s.state = 'running';
      s.error = null;
      s.pendingPrompt = prompt;
      s.turn += 1;
      await save(id, s);

      const dirs = await readingDirs(id, card, s);
      // The session lives in the folder of its first turn: later turns keep it (a checkout is made again at the same place).
      if (s.cwd && !existsSync(s.cwd)) Object.assign(s, { cwd: null, sessionId: null });
      s.cwd ??= (s.sessionId ? repos[0] : dirs[0]?.path) ?? store.dir(id);
      const cwd = s.cwd;
      await mkdir(cwd, { recursive: true });
      await save(id, s);
      const checkouts = dirs.filter((d) => d.ref);
      if (checkouts.length) {
        prompt = [prompt, '\nWhere the code is: read each repository here, not anywhere else.',
          ...dirs.map((d) => `- ${d.repo}: ${d.path}${d.ref ? ` = ${d.ref}, the branch the work will start from and go back into (a read-only checkout made for you)` : ' (the repository folder)'}${d.path === cwd ? ', your working directory' : ''}`)].join('\n');
      }
      await store.update(id, { status: 'refining' });
      await emit(id, { kind: 'turn', turn: s.turn });
      log('refine', `Tarkennus alkoi: ${card.title} (vuoro ${s.turn})`, { card: id });

      const args = [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--json-schema', JSON.stringify(REFINE_SCHEMA),
        '--permission-mode', 'plan',
        '--allowedTools', ...READ_ONLY_TOOLS,
        '--disallowedTools', ...BLOCKED_TOOLS,
      ];
      const project = await projectSettings(card);
      const map = await projectContext(card).catch(() => null); // what the project's earlier exploration found out about the code
      args.push('--append-system-prompt', map ? `${SYSTEM_PROMPT}\n\n${map.section}` : SYSTEM_PROMPT);
      for (const dir of map?.dirs ?? []) args.push('--add-dir', dir);
      const useModel = card.model ?? project.model ?? model;
      const useEffort = card.effort ?? project.effort ?? effort;
      if (useModel) args.push('--model', useModel);
      if (useEffort) args.push('--effort', useEffort);
      for (const d of dirs) if (d.path !== cwd) args.push('--add-dir', d.path);
      // Pasted images live in the card folder; the refiner may read them there (long path: an 8.3 one asks for permission).
      const images = attachments ? await attachments.list(id) : [];
      if (images.length) args.push('--add-dir', realpathSync.native(attachments.dir(id)));
      if (s.sessionId) args.push('--resume', s.sessionId);
      if (images.length) prompt = `${prompt}\n${imagesSection(images.map((i) => ({ path: join(realpathSync.native(attachments.dir(id)), i.name) })))}`;

      let sessionSaved = Boolean(s.sessionId);
      const onEvent = (event) => {
        if (!sessionSaved && event.session_id) {
          sessionSaved = true;
          s.sessionId = event.session_id;
          save(id, s).catch(() => {});
        }
        for (const entry of toLive(event)) emit(id, entry);
      };

      const result = await claude.run({ args, cwd, prompt, onEvent });
      const out = result.structured_output;
      if (result.is_error || !out || typeof out !== 'object') {
        throw new Error(result.result || `claude returned no structured output (${result.subtype ?? 'unknown'})`);
      }
      s.sessionId = result.session_id ?? s.sessionId;
      s.summary = String(out.summary ?? '');
      s.questions = Array.isArray(out.questions) ? out.questions : [];
      s.plan = String(out.plan ?? '');
      s.ready = Boolean(out.ready) && s.questions.length === 0;
      s.cost = round(s.cost + (result.total_cost_usd ?? 0));
      s.usage = addUsage(s.usage, usageFromResult(result));
      ledger?.record('refine', usageFromResult(result), { card: id });
      s.state = 'idle';
      s.pendingPrompt = null;
      await save(id, s);
      log('refine', `Tarkennus valmis: ${card.title}: ${s.questions.length ? `${s.questions.length} kysymystä sinulle` : 'suunnitelma valmis hyväksyttäväksi'}`, { card: id, level: s.questions.length ? 'warn' : undefined });
    } catch (e) {
      const s = await load(id);
      s.state = 'error';
      s.error = e.message;
      await save(id, s);
      log('refine', `Tarkennus epäonnistui: ${(await store.get(id).catch(() => null))?.title ?? id}: ${e.message}`, { card: id, level: 'error' });
      await emit(id, { kind: 'error', message: e.message });
    } finally {
      running.delete(id);
      await emit(id, { kind: 'idle' });
    }
  }

  /** `confirmed`: the person agreed to refine although the card it depends on is not there yet. */
  async function start(id, { confirmed = false } = {}) {
    const card = await store.get(id);
    if (card.status !== 'inbox' && card.status !== 'refining') throw new ValidationError(`Cannot refine a card in status ${card.status}`);
    const s = await load(id);
    if (s.plan || s.state === 'running') throw new ValidationError('Refinement has already started; answer the questions instead');
    const dep = unmetDependency(card, await store.list());
    if (dep && !confirmed) {
      const what = card.afterKind === 'planned' ? 'its plan is approved' : 'it is done';
      throw new ConfirmationError(`"${card.title}" depends on "${dep.title}" (${dep.status}), and should wait until ${what}. Refine it anyway?`,
        { blockedBy: { id: dep.id, title: dep.title, status: dep.status }, afterKind: card.afterKind ?? 'done' });
    }
    const prompt = [
      `Ticket: ${card.title}`,
      card.brief ? `\nBrief:\n${card.brief}` : '',
      card.repos.length ? `\nRepositories: ${card.repos.join(', ')} (the first is your working directory)` : '\nNo repository was given.',
      '\nRefine this ticket: explore the code, ask what you need to, and write the plan.',
    ].join('\n');
    return background(id, prompt);
  }

  async function answer(id, { answers = {}, message = '' } = {}) {
    const s = await load(id);
    if (s.state === 'running') throw new ValidationError('Refinement is still running');
    if (s.turn === 0) throw new ValidationError('Start refinement first');
    const lines = [];
    for (const q of s.questions) {
      const a = typeof answers[q.id] === 'string' ? answers[q.id].trim() : '';
      lines.push(`- ${q.text}\n  Answer: ${a || `(no answer; use your recommendation: ${q.recommended})`}`);
    }
    const extra = typeof message === 'string' ? message.trim() : '';
    if (!lines.length && !extra) throw new ValidationError('Nothing to answer');
    s.history.push({ turn: s.turn, answers, message: extra, questions: s.questions.map((q) => ({ id: q.id, text: q.text })), at: new Date().toISOString() });
    await save(id, s);
    const prompt = [lines.length ? `Answers to your questions:\n${lines.join('\n')}` : '', extra ? `\nMessage:\n${extra}` : '',
      '\nUpdate the plan. Ask further questions only if something is still blocking.'].join('\n');
    return background(id, prompt);
  }

  // Validates, then runs the turn in the background and returns as soon as it is accepted,
  // so a bad request gets a 4xx rather than a silently failed turn.
  const inFlight = new Set();
  async function background(id, prompt) {
    repoPaths(await store.get(id));
    if (running.has(id)) throw new ValidationError('Refinement is already running for this card');
    const done = runTurn(id, prompt).catch((e) => console.error(`refine ${id}:`, e.message));
    inFlight.add(done);
    done.finally(() => inFlight.delete(done));
    return { accepted: true };
  }

  /** Re-runs the last turn, e.g. after an error or an interrupted restart. */
  async function rerunPending(id) {
    const s = await load(id);
    if (!s.pendingPrompt) throw new ValidationError('Nothing to retry');
    if (s.state === 'running' && running.has(id)) throw new ValidationError('Refinement is already running');
    s.turn = Math.max(0, s.turn - 1); // runTurn increments again
    await save(id, s);
    return background(id, s.pendingPrompt);
  }

  async function approve(id, { force = false } = {}) {
    const card = await store.get(id);
    const s = await load(id);
    if (s.state === 'running') throw new ValidationError('Refinement is still running');
    if (!s.plan) throw new ValidationError('There is no plan yet');
    if (!s.ready && !force) throw new ValidationError('The plan is not marked ready; answer the open questions or force it');
    if (card.status !== 'refining') throw new ValidationError(`Cannot start work on a card in status ${card.status}`);
    const updated = await store.update(id, { status: 'ready' });
    await removeCheckouts(id).catch((e) => log('refine', `Tarkennuksen työkansion poisto epäonnistui: ${e.message}`, { card: id, level: 'warn' }));
    return updated;
  }

  /** After a restart: re-run turns that were cut off, and remove the checkouts of cards that left refining. */
  async function resumeInterrupted() {
    if (checkoutsDir) {
      for (const id of await readdir(checkoutsDir).catch(() => [])) {
        const card = await store.get(id).catch(() => null);
        if (card?.status !== 'inbox' && card?.status !== 'refining') await removeCheckouts(id).catch((e) => console.error(`checkouts ${id}:`, e.message));
      }
    }
    for (const card of await store.list()) {
      const s = await load(card.id).catch(() => null);
      if (s?.state === 'running' && s.pendingPrompt) {
        await rerunPending(card.id).catch((e) => console.error(`resume ${card.id}:`, e.message));
      }
    }
  }

  async function liveTail(id, max = 200) {
    const read = (f) => readFile(f, 'utf8').then((t) => t.split('\n').filter(Boolean), () => []);
    let lines = await read(liveFile(id));
    if (lines.length < max) lines = [...(await read(liveFile(id).replace(/\.jsonl$/, '.1.jsonl'))), ...lines]; // just rotated
    return lines.slice(-max).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }

  function subscribe(id, fn) {
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(fn);
    return () => subscribers.get(id)?.delete(fn);
  }

  /** Resolves when no turn is in flight (for tests and graceful shutdown). */
  const settled = async () => { while (inFlight.size) await Promise.all([...inFlight]); };

  return {
    get: async (id) => { await store.get(id); return load(id); },
    start, answer, approve, retry: rerunPending, resumeInterrupted, liveTail, subscribe, settled,
    busy: () => [...running], // card ids with a turn in flight
  };
}

function round(n) { return Math.round(n * 1e4) / 1e4; }

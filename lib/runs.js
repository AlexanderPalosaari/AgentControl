import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfirmationError, ValidationError, unmetDependencies, unmetDependency } from './cards.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { createWorktree, git } from './git.js';
import { createRepos } from './repos.js';
import { actionableFindings, fixRequest, reviewMarkdown, verificationFinding } from './review.js';
import { imagesSection } from './attachments.js';
import { addUsage, emptyUsage } from './usage.js';

export const DEFAULT_ALLOWED_TOOLS = [
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  'Bash(git show:*)', 'Bash(git mv:*)', 'Bash(git rm:*)',
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(node:*)', 'Bash(dotnet build:*)', 'Bash(dotnet test:*)',
  'Bash(npm start:*)', 'Bash(dotnet run:*)', 'Bash(curl:*)',
  'PowerShell(Invoke-RestMethod:*)', 'PowerShell(Invoke-WebRequest:*)',
  'mcp__chrome-devtools',
];
export const DISALLOWED_TOOLS = ['Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)'];
/**
 * A research card's agent studies and reports: it may read the code and its history and search the web, but not
 * change the checkout (no Edit, no commits). It still writes its own files in the card folder with Write.
 */
export const RESEARCH_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git grep:*)',
];
export const RESEARCH_DISALLOWED_TOOLS = [
  ...DISALLOWED_TOOLS, 'Edit', 'NotebookEdit',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(rm:*)',
];
const isResearch = (card) => card?.kind === 'research';
/** The lock that runs commands sharing one resource one at a time (see serial.js). */
export const SERIAL_SCRIPT = fileURLToPath(new URL('../scripts/serial.js', import.meta.url));
/** A name part unique to the card, safe in database, folder and container names: keeps parallel runs apart. */
export const isolationKey = (id) => `ac_${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`;
/** Where the agent works: its worktrees, or for a research card without a repository its own empty folder. */
const workDirs = (run) => (run.worktrees?.length ? run.worktrees.map((w) => w.path) : run.cwd ? [run.cwd] : []);
const mainCwd = (run) => realpathSync.native(workDirs(run)[0]);

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const FINISH_GRACE_MS = 45_000; // a report written while the agent is still busy counts after this long
const ENDED_GRACE_MS = 20_000;  // after a (re)start, "not working" is not yet a verdict
const MAX_FILE_BYTES = 100_000;
const MAX_DIFF_CHARS = 400_000;

/**
 * Starts ready cards as background Claude Code agents (one git worktree per repo),
 * watches them, and moves the card: running -> needs_input -> review.
 * The agent's model and effort: the card's own choice, else its project's (`projectSettings`, by the first
 * repo), else the `model` / `effort` defaults. The result is kept in run.json, so a resumed agent keeps it.
 * Each worktree forks from the card's base branch, else its repository's project's (`projectBase`), else the
 * repository's default branch; run.json keeps that base and the commit it forked from (`forkSha`).
 *
 * The files in the card folder are the contract with the agent:
 *   prompt.md (in), question.md (agent is stuck), report.md (written LAST: finished),
 *   commit-message.txt, followups.json (out).
 */
export function createRunner({
  store, agents, dataDir, reposRoot, repos = createRepos({ reposRoot }), refiner = null, reviewer = null, attachments = null,
  trust = async () => {}, // the real app passes createTrust(); tests must never touch the person's Claude config
  dayLimit = 4, nightLimit = 6, nightStart = 22, nightEnd = 7,
  model = null, effort = null, projectSettings = async () => ({}), projectContext = async () => null, projectBase = async () => null,
  allowedTools = DEFAULT_ALLOWED_TOOLS, tickMs = 5000,
  // auto: Claude Code's own safety check approves ordinary commands (npm, ls, tests) and stops risky ones, so an
  // unattended agent rarely stalls on a prompt nobody sees. The disallowed list (push, remotes, config) still applies.
  permissionMode = 'auto',
  openWindow = null, // tests replace the console window that `attach` opens
  ledger = null, transcripts = null, // token accounting (see usage.js); off unless the app passes them
  log = () => {}, // the event journal
  now = () => new Date(), enabled = true, // `now` only decides the day/night WIP limit; timestamps use the real clock
}) {
  const worktreesDir = join(dataDir, 'worktrees');
  const locks = new Set();     // card ids with an action in flight
  const misses = new Map();    // card id -> consecutive observations of "ended without a report"
  const inFlight = new Set();  // background review tasks
  let timer = null;
  let ticking = false;
  let dispatchEnabled = enabled;
  let lastEntries = []; // `claude agents` as the last tick saw it (the console view reads session ids from it)

  const runFile = (id) => join(store.dir(id), 'run.json');
  const cardFile = (id, name) => join(store.dir(id), name);
  const loadRun = (id) => readJson(runFile(id), null);
  const saveRun = (id, run) => { run.updatedAt = new Date().toISOString(); return writeJsonAtomic(runFile(id), run); };

  async function cardDirReal(id) {
    await mkdir(store.dir(id), { recursive: true });
    return realpathSync.native(store.dir(id)); // long form: agents compare paths literally
  }

  // The WIP limits and the night window can be changed while running (Settings page); the dispatcher reads them on every tick.
  const cfg = { dayLimit, nightLimit, nightStart, nightEnd };

  function limit() {
    const h = now().getHours();
    const night = cfg.nightStart > cfg.nightEnd ? h >= cfg.nightStart || h < cfg.nightEnd : h >= cfg.nightStart && h < cfg.nightEnd;
    return { night, limit: night ? cfg.nightLimit : cfg.dayLimit };
  }

  /** Validates and applies any of dayLimit, nightLimit (1-20) and nightStart, nightEnd (hours 0-23); returns the whole config. */
  function setLimits(input = {}) {
    const next = { ...cfg };
    for (const [key, min, max] of [['dayLimit', 1, 20], ['nightLimit', 1, 20], ['nightStart', 0, 23], ['nightEnd', 0, 23]]) {
      if (input[key] === undefined) continue;
      const v = input[key];
      if (!Number.isInteger(v) || v < min || v > max) throw new ValidationError(`${key} must be a whole number from ${min} to ${max}`);
      next[key] = v;
    }
    if (next.nightStart === next.nightEnd) throw new ValidationError('The night window cannot be empty: nightStart and nightEnd must differ');
    Object.assign(cfg, next);
    return { ...cfg };
  }

  async function withLock(id, fn) {
    if (locks.has(id)) throw new ValidationError('Another action is in progress for this card');
    locks.add(id);
    try { return await fn(); } finally { locks.delete(id); }
  }

  // ---------- starting ----------

  async function buildPrompt(card, run, dir, map = null) {
    const refine = refiner ? await refiner.get(card.id).catch(() => null) : null;
    const decisions = (refine?.history ?? []).flatMap((h) => [
      ...Object.entries(h.answers ?? {}).map(([q, a]) => `- ${h.questions?.find((x) => x.id === q)?.text ?? q} → ${a}`),
      ...(h.message ? [`- Message from the person: ${h.message}`] : []),
    ]);
    // Through the card folder as the agent knows it (`dir`, the real path), which it may read.
    const images = attachments ? (await attachments.list(card.id)).map((a) => ({ path: join(dir, 'attachments', a.name) })) : [];
    return [
      `# Task: ${card.title}`,
      card.brief ? `\n${card.brief}` : '',
      imagesSection(images),
      map ? `\n${map.section}\n` : '',
      refine?.plan ? `\n## Approved plan\n\n${refine.plan}` : '\n## Plan\n\nNo plan was written; use your judgment and keep the change small.',
      decisions.length ? `\n## Decisions made while refining\n\n${decisions.join('\n')}` : '',
      '\n## Where things are',
      ...run.worktrees.map((w, i) => `- ${i === 0 ? 'Working directory (your cwd)' : 'Additional worktree'}: ${w.path} (repo ${w.repo}, branch ${w.branch}, forked from ${w.base}; the work goes into ${w.base.replace(/^origin\//, '')})`),
      `- Card folder for your output files: ${dir}`,
      '\n## Rules',
      '- Work only inside the worktrees above and the card folder. Commit your work on the current branch (several commits are fine).',
      '- Your shell already starts in the working directory: do not `cd` and do not use `git -C`; those commands are not pre-approved and will stall you. Prefer the Read, Glob and Grep tools over shell commands for looking around.',
      '- Never push, never change remotes or git config, never switch or delete branches. A person decides what leaves this machine.',
      '- Your branch was already forked from the right base branch (above). Never rebase, reset or recreate it onto another branch, and never merge other branches into it yourself (when its base has moved on, AgentControl merges it in for you to resolve). If the task names a different base or target branch than the one above, do not move the branch: write the mismatch to `question.md` and stop.',
      '- Build, and run the tests that cover what you changed: the test classes or files of the code you touched and its direct callers (e.g. `dotnet test --filter`, `npx jest <files>`, `pytest <files>`). Do not run the whole test suite when it takes more than a few minutes; it is run once when the work is merged. Fix what you broke, and list in Verification which tests you ran.',
      `- Other agents work on this machine at the same time. Anything your build, tests or app run share — a database, a port, a temp or output folder outside your worktree — must be your own: name it with your isolation key \`${isolationKey(card.id)}\` (e.g. a test database \`<Name>_${isolationKey(card.id)}\`). If the repository's instructions say how to choose the test database or port (e.g. an environment variable), use that. Never stop or reuse another run's database or process.`,
      `- Tests that use something you cannot make your own — e.g. a test database whose name the code fixes — must run one at a time across all agents: run them through the lock \`node "${SERIAL_SCRIPT}" <repo> -- <test command>\` (for example \`node "${SERIAL_SCRIPT}" ${run.worktrees[0]?.repo ?? 'repo'} -- dotnet test <project> --filter "<filter>"\`), with the repository's name as <repo>. It waits while another card holds it, which can take minutes, so run it in the background and wait for the result instead of letting the command time out. Do not change the tests or their setup to avoid the shared resource.`,
      '- Test the feature you built in practice, not only with unit tests: start the app locally (in the background, on a free non-default port, and stop it when done), call the changed API endpoints with curl or Invoke-RestMethod, and for UI changes drive the page with the chrome-devtools tools (open the local URL, click through the flow, check console and network). Use only localhost and test data; never touch production systems or real credentials. Follow the Verification section of the plan. Skipping a check (API, browser or tests) is allowed only with a concrete reason that is specific to this change.',
      '- Every check is yours to run, browser flows included, even where the plan or the task says a person tests something by hand: never hand a check over to the person. "The user tests it manually" is not a reason to skip; a report that leaves checks to a person is sent back to you.',
      '- `report.md` must contain a `## Verification` section that lists, per check, either `Tested:` with what you ran and what you saw, or `Skipped:` with the reason. A report without that section is sent back to you.',
      '- If you need a human decision, or a command was denied: write the question (with options) to `question.md` in the card folder and stop. Do not work around a denied permission.',
      '- When finished, write in the card folder: `commit-message.txt` (proposed squash commit message, first line at most 72 characters), optionally `followups.json` (array of {"title","brief"} for out-of-scope findings), and LAST `report.md` (what you did, how you verified it, risks and open points). Writing `report.md` signals that you are done, so do it last.',
    ].filter((l) => l !== '').join('\n');
  }

  /** The task of a research card: study and report, change nothing. */
  async function buildResearchPrompt(card, run, dir, map = null) {
    const images = attachments ? (await attachments.list(card.id)).map((a) => ({ path: join(dir, 'attachments', a.name) })) : [];
    return [
      `# Research: ${card.title}`,
      card.brief ? `\n${card.brief}` : '',
      imagesSection(images),
      map ? `\n${map.section}\n` : '',
      '\nThis is a research card: your job is to find things out and report them, NOT to change code. Analyse the code, its history, documents and, where useful, the web; compare options; gather facts with their sources.',
      '\n## Where things are',
      ...(run.worktrees.length
        ? run.worktrees.map((w, i) => `- ${i === 0 ? 'Checkout to study (your cwd)' : 'Additional checkout'}: ${w.path} (repo ${w.repo}, at ${w.base})`)
        : ['- No repository: work from what the task says, documents and the web.']),
      `- Card folder for your output files: ${dir}`,
      '\n## Rules',
      '- Do not change, create or delete files in the checkouts, and do not commit. Write only in the card folder.',
      '- Your shell already starts in the right folder: do not `cd` and do not use `git -C`. Prefer the Read, Glob and Grep tools over shell commands for looking around.',
      '- Never push, never change remotes or git config. Never touch production systems or real credentials.',
      '- If you need a human decision to go on (e.g. the question is ambiguous): write the question (with options) to `question.md` in the card folder and stop.',
      '- When finished, write in the card folder: optionally `followups.json` (array of {"title","brief"}: work you recommend, each a ticket an agent could do on its own), and LAST `report.md`: the answer first (a short summary of the findings and your recommendation), then the details, the evidence with sources (file paths with line numbers, commits, URLs) and open questions. Writing `report.md` signals that you are done, so do it last.',
    ].filter((l) => l !== '').join('\n');
  }

  /**
   * The commit a reused worktree's branch forked from: kept from the earlier run, which must have had the same base.
   * Without one (a run from before forkSha was kept) it is where the branch meets the base.
   */
  async function knownForkPoint(prev, wt) {
    const before = prev?.worktrees?.find((w) => w.repo === wt.repo);
    if (before && before.base !== wt.base) {
      throw new ValidationError(`${wt.repo}: the work was started from ${before.base}, but the card now targets ${wt.base}. Remove the worktree ${wt.path} (git worktree remove --force) and its branch ${wt.branch} to start over from ${wt.base}.`);
    }
    return before?.forkSha ?? await git(['merge-base', 'HEAD', wt.base], wt.path).catch(() => null);
  }

  /** The tool lists of a run: a research run may only read (see RESEARCH_ALLOWED_TOOLS). */
  const toolsFor = (run) => (run.kind === 'research'
    ? { allowedTools: RESEARCH_ALLOWED_TOOLS, disallowedTools: RESEARCH_DISALLOWED_TOOLS }
    : { allowedTools, disallowedTools: DISALLOWED_TOOLS });

  async function startRun(card) {
    const id = card.id;
    const dir = await cardDirReal(id);
    const project = await projectSettings(card);
    const prev = await loadRun(id); // a retry reuses the worktrees the earlier run made
    const run = {
      state: 'starting', agentId: null, worktrees: [], startedAt: new Date().toISOString(), finishedAt: null,
      model: card.model ?? project.model ?? model, effort: card.effort ?? project.effort ?? effort, error: null, waitingFor: null, replies: 0, permissionMode,
      kind: card.kind ?? 'task',
    };
    const research = isResearch(card);
    await saveRun(id, run);
    await store.update(id, { status: 'running' });
    try {
      const slug = card.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task';
      for (const name of card.repos) {
        const repoPath = repos.path(name);
        const target = card.baseBranch ?? await projectBase(name);
        const wt = { repo: name, ...await createWorktree({ repoPath, path: join(worktreesDir, id, name), branch: `ac/${id}-${slug}`, target }) };
        if (!wt.forkSha) wt.forkSha = await knownForkPoint(prev, wt);
        run.worktrees.push(wt);
      }
      if (!run.worktrees.length && research) {
        // Nothing to check out: an empty folder of its own, inside the worktrees folder so it can be trusted.
        run.cwd = join(worktreesDir, id, '_research');
        await mkdir(run.cwd, { recursive: true });
      }
      if (!workDirs(run).length) throw new Error('The card has no repository; add one before starting work');
      await saveRun(id, run);
      const map = await projectContext(card).catch(() => null); // the project's code map, when it has been explored
      await writeFile(cardFile(id, 'prompt.md'), await (research ? buildResearchPrompt : buildPrompt)(card, run, dir, map), 'utf8');
      await trust(workDirs(run)); // claude --bg refuses a folder nobody has trusted yet
      run.agentId = await agents.start({
        cwd: mainCwd(run),
        message: `Read ${join(dir, 'prompt.md')} and carry out the task described in it exactly.`,
        model: run.model, effort: run.effort, ...toolsFor(run), permissionMode,
        addDirs: [dir, ...run.worktrees.slice(1).map((w) => realpathSync.native(w.path)), ...(map?.dirs ?? [])],
      });
      run.state = 'running';
      await saveRun(id, run);
      log('agent', `${research ? 'Selvitysagentti' : 'Agentti'} käynnistyi: ${card.title} (${run.agentId}, ${permissionMode}-tila)`, { card: id });
    } catch (e) {
      run.state = 'failed';
      run.error = e.message;
      await saveRun(id, run);
      await store.update(id, { status: 'needs_input' });
      log('agent', `Agentin käynnistys epäonnistui: ${card.title}: ${e.message}`, { card: id, level: 'error' });
    }
  }

  /** The ready cards that could start now (dependency met), in the order the dispatcher takes them. */
  const startOrder = (cards) => cards
    .filter((c) => c.status === 'ready' && !unmetDependency(c, cards) && !locks.has(c.id))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));

  async function dispatch() {
    if (!dispatchEnabled) return;
    const cards = await store.list();
    const running = cards.filter((c) => c.status === 'running').length;
    let free = limit().limit - running;
    if (free <= 0) return;
    for (const card of startOrder(cards)) {
      if (free-- <= 0) break;
      await withLock(card.id, () => startRun(card)).catch((e) => console.error(`start ${card.id}:`, e.message));
    }
  }

  // ---------- watching ----------

  // A step whose failure does not stop the work still leaves a trace in the event log, where the person can see it.
  const warn = (card, what) => (e) => log('agent', `${what}: ${e.message}`, { card: card.id ?? card, level: 'warn' });

  const exists = (id, name) => existsSync(cardFile(id, name));
  const mtimeMs = (id, name) => stat(cardFile(id, name)).then((s) => s.mtimeMs).catch(() => 0);

  /**
   * Adds what the agent's session has spent since the last look to the ledger and to the run's running total.
   * Cheap on a quiet agent: the transcript is only read from where it was left. Never fails the caller.
   */
  async function collectUsage(card, run, entry) {
    if (!transcripts || !workDirs(run).length) return;
    const sessionId = entry?.sessionId ?? run.sessionId;
    if (!sessionId) return;
    try {
      const delta = await transcripts.collect(await cardDirReal(card.id), { sessionId, cwd: mainCwd(run) });
      if (run.sessionId !== sessionId) { run.sessionId = sessionId; await saveRun(card.id, run); }
      if (Object.values(delta).every((n) => !n)) return;
      run.usage = addUsage(run.usage ?? emptyUsage(), delta);
      ledger?.record('agent', delta, { card: card.id });
      await saveRun(card.id, run);
    } catch (e) {
      console.error(`usage ${card.id}: ${e.message}`);
    }
  }

  async function observe(card, run, entries) {
    const entry = entries.find((a) => a.id === run.agentId);
    // Right after (re)starting, an agent reads status undefined + state working, so look at both fields.
    const busy = entry?.status === 'busy' || entry?.state === 'working';
    if (exists(card.id, 'question.md')) return { kind: 'question' };
    if (exists(card.id, 'report.md')) {
      const age = Date.now() - await mtimeMs(card.id, 'report.md'); // real clock: `now` is only for the day/night window
      if (!busy || age > FINISH_GRACE_MS) return { kind: 'finished' };
    }
    if (entry?.status === 'waiting' || entry?.state === 'blocked') return { kind: 'blocked', waitingFor: entry.waitingFor ?? 'permission prompt' };
    if (busy) return { kind: 'working' };
    return { kind: 'ended' };
  }

  async function monitor() {
    const cards = await store.list();
    const active = [];
    for (const card of cards) {
      if ((card.status !== 'running' && card.status !== 'needs_input') || locks.has(card.id)) continue;
      const run = await loadRun(card.id);
      if (!run) continue;
      if (run.state === 'starting' && !locks.has(card.id)) {
        // The server died between "starting" and the agent being launched.
        await store.update(card.id, { status: 'ready' });
        await saveRun(card.id, { ...run, state: 'failed', error: 'Interrupted while starting; it will be started again' });
        continue;
      }
      if (run.state === 'reviewing') { startReview(card.id); continue; } // also resumes a review cut off by a restart
      if (run.state === 'running' || (run.state === 'needs_input' && !run.error)) active.push({ card, run });
    }
    if (!active.length) return;
    const entries = await agents.list();
    lastEntries = entries;
    for (const { card, run } of active) {
      if (locks.has(card.id)) continue;
      const seen = await observe(card, run, entries);
      if (seen.kind === 'ended') {
        if (Date.now() - Date.parse(run.updatedAt) < ENDED_GRACE_MS) continue; // just (re)started: the job may not be listed as working yet
        const n = (misses.get(card.id) ?? 0) + 1;
        misses.set(card.id, n);
        if (n < 2) continue; // one bad reading is not a verdict
        misses.delete(card.id);
        run.state = 'failed';
        run.error = 'The agent ended without writing report.md or question.md';
        await saveRun(card.id, run);
        await store.update(card.id, { status: 'needs_input' });
        log('agent', `Agentti päättyi ilman raporttia: ${card.title}`, { card: card.id, level: 'error' });
        continue;
      }
      misses.delete(card.id);
      await collectUsage(card, run, entries.find((a) => a.id === run.agentId));
      if (seen.kind === 'working' && run.state !== 'running') {
        Object.assign(run, { state: 'running', waitingFor: null });
        await saveRun(card.id, run);
        await store.update(card.id, { status: 'running' });
      } else if (seen.kind === 'blocked' && (run.permissionMode ?? 'acceptEdits') !== permissionMode && !run.modeSwitched) {
        // Started in a stricter mode (e.g. before agents ran in auto mode): nobody sees its prompt, so continue the
        // same session in the configured mode instead of waiting for the person. Once only; after that it is theirs.
        await withLock(card.id, () => resumeInMode(card, run, entries))
          .catch((e) => console.error(`resume ${card.id} in ${permissionMode} mode:`, e.message));
      } else if (seen.kind === 'blocked' && run.state !== 'needs_input') {
        Object.assign(run, { state: 'needs_input', waitingFor: seen.waitingFor });
        await saveRun(card.id, run);
        await store.update(card.id, { status: 'needs_input' });
        log('agent', `Agentti pyytää lupaa: ${card.title}`, { card: card.id, level: 'warn' });
      } else if (seen.kind === 'question' && (run.state !== 'needs_input' || run.waitingFor)) {
        Object.assign(run, { state: 'needs_input', waitingFor: null });
        await saveRun(card.id, run);
        await store.update(card.id, { status: 'needs_input' });
        log('agent', `Agentti kysyy: ${card.title}`, { card: card.id, level: 'warn' });
      } else if (seen.kind === 'finished') {
        log('agent', `${run.kind === 'research' ? 'Selvitys valmis' : 'Agentti valmis'}: ${card.title}`, { card: card.id });
        await agents.stop(run.agentId).catch(warn(card, 'Agentin pysäytys epäonnistui')); // idle jobs keep a process alive
        if (reviewer && !run.review?.round && run.kind !== 'research') { // a research card changed no code: nothing to review
          Object.assign(run, { state: 'reviewing', waitingFor: null });
          await saveRun(card.id, run);
          startReview(card.id);
        } else {
          await finalize(card.id, run);
        }
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await monitor();
      await dispatch();
    } catch (e) {
      console.error('runner tick:', e.message);
    } finally {
      ticking = false;
    }
  }

  // ---------- human actions ----------

  /**
   * Queues a research card to be started: it needs no refinement or approved plan (it changes nothing), so it goes
   * from Inbox (or Refining) straight to Ready, where the dispatcher starts it as usual. `confirmed`: the person
   * agreed to start although a card it depends on is not there yet.
   */
  async function startResearch(id, { confirmed = false } = {}) {
    const card = await store.get(id);
    if (!isResearch(card)) throw new ValidationError('Only a research card starts without refinement');
    if (card.status !== 'inbox' && card.status !== 'refining') throw new ValidationError(`Cannot start research in status ${card.status}`);
    const unmet = unmetDependencies(card, await store.list());
    if (unmet.length && !confirmed) {
      const { dep, kind } = unmet[0];
      throw new ConfirmationError(`"${card.title}" depends on ${unmet.map((u) => `"${u.dep.title}" (${u.dep.status})`).join(', ')}. Start the research anyway?`, {
        blockedBy: { id: dep.id, title: dep.title, status: dep.status }, afterKind: kind,
        blockers: unmet.map((u) => ({ id: u.dep.id, title: u.dep.title, status: u.dep.status, kind: u.kind })),
      });
    }
    await store.update(id, { status: 'ready' });
    log('agent', `Selvitys jonossa: ${card.title}`, { card: id });
    // Ready waits for its dependencies in the dispatcher; a confirmed start does not, so start it now if there is room.
    if (unmet.length) await withLock(id, async () => startRun(await store.get(id))).catch((e) => console.error(`start ${id}:`, e.message));
    return { queued: true };
  }

  /** Sends the person's reply (or a plain "continue") to the agent's session. */
  function answer(id, { message = '' } = {}) {
    return withLock(id, async () => {
      const card = await store.get(id);
      const run = await loadRun(id);
      if (!run?.agentId) throw new ValidationError('This card has no agent to answer; use retry');
      if (run.state === 'running') throw new ValidationError('The agent is still working');
      const text = typeof message === 'string' ? message.trim() : '';
      if (run.state === 'needs_input' && exists(id, 'question.md') && !text) throw new ValidationError('Write an answer to the question');
      await sendToAgent(id, run, { text: text || 'Continue where you left off.', intro: 'A person replied.' });
      return { accepted: true, card: card.id };
    });
  }

  /** Stops an agent stuck on a permission prompt and continues its session in the configured permission mode. */
  async function resumeInMode(card, run, entries) {
    const entry = entries.find((a) => a.id === run.agentId);
    if (!entry?.sessionId) return;
    const dir = await cardDirReal(card.id);
    await agents.stop(run.agentId).catch(warn(card, 'Agentin pysäytys epäonnistui'));
    await trust(workDirs(run));
    run.agentId = await agents.resume({
      cwd: mainCwd(run),
      sessionId: entry.sessionId,
      message: `You were waiting for a permission prompt that nobody can answer. You now run in ${permissionMode} permission mode: continue the task where you left off, retrying that step if it is still needed. Same rules as before: write question.md if blocked and report.md last when done.`,
      model: run.model, effort: run.effort, ...toolsFor(run), permissionMode,
      addDirs: [dir, ...run.worktrees.slice(1).map((w) => realpathSync.native(w.path))],
    });
    Object.assign(run, { state: 'running', error: null, waitingFor: null, permissionMode, modeSwitched: true });
    await saveRun(card.id, run);
    await store.update(card.id, { status: 'running' });
    log('agent', `Agentti jäi lupakyselyyn ja jatkaa ${permissionMode}-tilassa: ${card.title} (${run.agentId})`, { card: card.id });
  }

  /** Wakes the agent's session with a message (written to replies/N.md). The caller holds the card's lock. */
  async function sendToAgent(id, run, { text, intro }) {
    const entry = (await agents.list()).find((a) => a.id === run.agentId);
    if (!entry) throw new ValidationError('The agent session no longer exists; use retry to start over');
    const n = run.replies + 1;
    const dir = await cardDirReal(id);
    await mkdir(join(dir, 'replies'), { recursive: true });
    const replyFile = join(dir, 'replies', `${n}.md`);
    await writeFile(replyFile, text, 'utf8');
    // Old question/report would otherwise be mistaken for the next turn's output.
    if (exists(id, 'question.md')) await rename(cardFile(id, 'question.md'), cardFile(id, `question.${n}.md`));
    if (exists(id, 'report.md')) await rename(cardFile(id, 'report.md'), cardFile(id, `report.prev-${n}.md`));

    await agents.stop(run.agentId).catch(warn(id, 'Agentin pysäytys epäonnistui')); // wake only continues the same job when it is stopped
    await trust(workDirs(run));
    run.agentId = await agents.wake({
      cwd: mainCwd(run),
      sessionId: entry.sessionId,
      message: `${intro} Read ${replyFile} and continue the task. Same rules as before: write question.md if blocked and report.md last when done.`,
    });
    Object.assign(run, { state: 'running', error: null, waitingFor: null, replies: n });
    await saveRun(id, run);
    const card = await store.update(id, { status: 'running' });
    log('agent', `Agentti jatkaa (${intro.startsWith('The automatic') ? 'katselmoinnin löydökset' : 'vastauksesi'}): ${card.title}`, { card: id });
  }

  // ---------- automatic review ----------

  async function finalize(id, run) {
    Object.assign(run, { state: 'finished', waitingFor: null, finishedAt: new Date().toISOString() });
    await saveRun(id, run);
    await store.update(id, { status: 'review' });
  }

  function startReview(id) {
    if (locks.has(id)) return;
    const task = withLock(id, () => runReview(id)).catch((e) => console.error(`review ${id}:`, e.message));
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  }

  /** Reviews each worktree. Real findings go back to the agent once; a failed review never blocks the card. */
  async function runReview(id) {
    const run = await loadRun(id);
    if (run?.state !== 'reviewing') return;
    const roundNow = run.review?.round ?? 0;
    try {
      const findings = [];
      const summaries = [];
      let cost = 0;
      let reviewUsage = emptyUsage();
      for (const wt of run.worktrees) {
        // Where the branch meets its base now: after AgentControl merged a moved base in, that is the base's tip, so
        // work merged in from other cards stays out of this card's review. The kept fork point is the fallback.
        const since = await git(['merge-base', 'HEAD', wt.base], wt.path).catch(() => null) ?? wt.forkSha ?? null;
        const r = await reviewer.review({ cwd: realpathSync.native(wt.path), base: wt.base, since });
        findings.push(...r.findings.map((f) => ({ repo: wt.repo, ...f })));
        summaries.push(r.summary);
        cost += r.cost;
        reviewUsage = addUsage(reviewUsage, r.usage);
      }
      const missing = verificationFinding(await readFile(cardFile(id, 'report.md'), 'utf8').catch(() => ''));
      if (missing) findings.push(missing);
      run.review = { state: 'done', round: roundNow, findings, summary: summaries.join('\n'), cost: Math.round(cost * 1e4) / 1e4, usage: reviewUsage, error: null };
    } catch (e) {
      run.review = { state: 'failed', round: roundNow, findings: [], summary: '', cost: 0, error: e.message };
    }
    if (run.review.usage) ledger?.record('review', run.review.usage, { card: id });
    await writeFile(cardFile(id, 'review.md'), reviewMarkdown(run.review), 'utf8');
    const title = (await store.get(id).catch(() => null))?.title ?? id;
    log('review', run.review.state === 'done' ? `Katselmointi: ${title}: ${run.review.findings.length} löydöstä` : `Katselmointi epäonnistui: ${title}: ${run.review.error}`,
      { card: id, level: run.review.state === 'done' ? undefined : 'error' });

    const actionable = actionableFindings(run.review.findings);
    if (run.review.state === 'done' && actionable.length && roundNow === 0) {
      try {
        run.review.round = 1;
        await sendToAgent(id, run, { text: fixRequest(actionable), intro: 'The automatic code review found possible problems.' });
        return;
      } catch (e) {
        run.review.round = roundNow;
        run.review.error = `Could not send the findings to the agent: ${e.message}`;
      }
    }
    await finalize(id, run);
  }

  function stop(id) {
    return withLock(id, async () => {
      const run = await loadRun(id);
      if (!run?.agentId || (run.state !== 'running' && run.state !== 'needs_input')) throw new ValidationError('Nothing to stop');
      await agents.stop(run.agentId);
      Object.assign(run, { state: 'stopped', waitingFor: null });
      await saveRun(id, run);
      const card = await store.update(id, { status: 'needs_input' });
      log('agent', `Agentti pysäytetty: ${card.title}`, { card: id });
      return { stopped: true };
    });
  }

  /** After a failure: continue the session if there is one, otherwise queue the card to be started again. */
  async function retry(id) {
    const run = await loadRun(id);
    if (!run || (run.state !== 'failed' && run.state !== 'stopped')) throw new ValidationError('Only failed or stopped runs can be retried');
    if (run.agentId) return answer(id, {});
    await store.update(id, { status: 'ready' });
    return { requeued: true };
  }

  /** Opens the card's agent in a console window, where its permission prompt can be answered. */
  /**
   * For work that conflicts with its base branch (other work went in first): merges the base into the card's
   * branch in the worktree, which leaves the conflicts there, and asks the agent to resolve them and finish the
   * merge. The card then goes through review again and can be accepted, or its pull request updated, as usual.
   * The base is where the work goes: for a pull request origin's branch, fetched now; for a local merge the local
   * branch, which holds other cards' accepted work that is not pushed yet.
   */
  function resolveConflicts(id) {
    return withLock(id, async () => {
      const run = await loadRun(id);
      if (run?.state !== 'finished' || !run.agentId) throw new ValidationError('Only finished work with an agent session can have its conflicts resolved');
      const viaPr = (await readJson(cardFile(id, 'prs.json'), [])).length > 0;
      const conflicts = [];
      try {
        for (const wt of run.worktrees) {
          const cwd = wt.path;
          if (await git(['status', '--porcelain'], cwd)) throw new ValidationError(`${wt.repo}: the worktree has uncommitted changes; commit or stash them first`);
          if (viaPr) await git(['fetch', 'origin', '--quiet'], cwd).catch(() => {}); // offline: as of the last fetch
          const target = wt.base.replace(/^origin\//, '');
          const local = !viaPr && await git(['rev-parse', '--verify', '--quiet', `refs/heads/${target}`], cwd).then(() => true, () => false);
          const base = local ? target : wt.base;
          const failed = await git(['merge', '--no-commit', '--no-ff', base], cwd).then(() => null, (e) => e); // a conflict is the expected failure
          const files = (await git(['diff', '--name-only', '--diff-filter=U'], cwd)).split('\n').filter(Boolean);
          if (!files.length) {
            await git(['merge', '--abort'], cwd).catch(() => {}); // a clean merge waits uncommitted; one that never started has nothing to abort
            if (failed) throw new ValidationError(`${wt.repo}: merging ${base} into the work failed: ${failed.message}`);
            continue;
          }
          conflicts.push({ repo: wt.repo, base, files, path: cwd });
        }
      } catch (e) {
        for (const c of conflicts) await git(['merge', '--abort'], c.path).catch(warn(id, `${c.repo}: merge --abort epäonnistui, worktree voi jäädä kesken jääneeseen mergeen`));
        throw e;
      }
      if (!conflicts.length) throw new ValidationError(viaPr ? 'No conflicts with the target branch here; the pull request may only need its new commits pushed' : 'No conflicts found; try accepting the work again');
      const list = conflicts.map((c) => `- ${c.repo} (${c.path}), merging ${c.base}: ${c.files.join(', ')}`).join('\n');
      const text = [
        'Other work was merged into the base branch while yours waited for approval, and it changes the same lines as your work.',
        'The base branch has been merged into your branch in each worktree, and git stopped with conflicts in:',
        list,
        '',
        'Resolve each conflict so that BOTH sides\' intent stays: the base branch already holds other cards\' accepted work, so do not drop it, and keep what this task needs. Remove every conflict marker, build and run the tests, then `git add` the files and finish with `git commit --no-edit`.',
        'Then update report.md and commit-message.txt if they no longer describe the work.',
      ].join('\n');
      try {
        await sendToAgent(id, run, { text, intro: 'Your work conflicts with its base branch.' });
      } catch (e) {
        for (const c of conflicts) await git(['merge', '--abort'], c.path).catch(warn(id, `${c.repo}: merge --abort epäonnistui, worktree voi jäädä kesken jääneeseen mergeen`));
        throw e;
      }
      log('agent', `Konfliktit annettu agentin ratkaistavaksi: ${conflicts.flatMap((c) => c.files).join(', ')}`, { card: id });
      return { resolving: conflicts.flatMap((c) => c.files) };
    });
  }

  /**
   * Removes a research card's checkouts and their branches once it is done or archived (it made no commits worth
   * keeping); its report and other files stay in the card folder. A no-op for other cards and for runs still going.
   */
  async function cleanupResearch(id) {
    const card = await store.get(id);
    const run = await loadRun(id);
    if (!isResearch(card) || !run || !['done', 'archive'].includes(card.status)) return { removed: 0 };
    if (run.agentId && ['running', 'needs_input'].includes(run.state)) await agents.stop(run.agentId).catch(warn(card, 'Agentin pysäytys epäonnistui'));
    let removed = 0;
    for (const wt of run.worktrees ?? []) {
      if (!existsSync(wt.path)) continue;
      let repoPath;
      try { repoPath = repos.path(wt.repo); } catch { continue; }
      await git(['worktree', 'remove', '--force', wt.path], repoPath).then(() => { removed++; }, warn(card, `Selvityksen työkansion poisto epäonnistui (${wt.path})`));
      await git(['branch', '-D', wt.branch], repoPath).catch(() => {});
    }
    if (run.cwd && existsSync(run.cwd)) await rm(run.cwd, { recursive: true, force: true }).then(() => { removed++; }, () => {});
    return { removed };
  }

  async function attach(id) {
    await store.get(id);
    const run = await loadRun(id);
    if (!run?.agentId) throw new ValidationError('This card has no agent to open');
    return agents.attachInWindow(run.agentId, openWindow ? { openWindow } : {});
  }

  async function details(id) {
    await store.get(id);
    const read = (name) => readFile(cardFile(id, name), 'utf8').then((t) => t.slice(0, MAX_FILE_BYTES), () => null);
    const followupsText = await read('followups.json');
    let followups = null;
    try { followups = followupsText ? JSON.parse(followupsText) : null; } catch { /* leave null; the raw file is still on disk */ }
    return {
      run: await loadRun(id),
      report: await read('report.md'),
      question: await read('question.md'),
      commitMessage: await read('commit-message.txt'),
      followups,
    };
  }

  /** What the agent changed: per worktree, `git diff <base>...HEAD`. Gone worktrees (done cards) are reported, not an error. */
  async function diff(id) {
    await store.get(id);
    const run = await loadRun(id);
    const repos = [];
    for (const wt of run?.worktrees ?? []) {
      if (!existsSync(wt.path)) { repos.push({ repo: wt.repo, branch: wt.branch, gone: true }); continue; }
      try {
        const range = `${wt.base}...HEAD`;
        const stat = await git(['diff', '--no-color', '--stat', range], wt.path);
        let patch = await git(['diff', '--no-color', '--no-ext-diff', range], wt.path);
        const truncated = patch.length > MAX_DIFF_CHARS;
        if (truncated) patch = patch.slice(0, MAX_DIFF_CHARS);
        repos.push({ repo: wt.repo, branch: wt.branch, base: wt.base, stat, patch, truncated });
      } catch (e) {
        repos.push({ repo: wt.repo, branch: wt.branch, error: e.message });
      }
    }
    return { repos };
  }

  /** The WIP slots and the start order of the waiting cards, for showing why a ready card has not started. */
  const queue = async () => {
    const cards = await store.list();
    const running = cards.filter((c) => c.status === 'running').length;
    return { ...limit(), running, enabled: dispatchEnabled, order: startOrder(cards).map((c) => c.id) };
  };

  /**
   * When the agent last changed anything in its worktree (a changed file or a commit), in ms since the epoch;
   * the start time when nothing changed yet, null without a run. A quiet agent is not necessarily stuck (it may
   * be reading), but long silence is also what a hung one looks like.
   */
  async function lastActivity(id) {
    const run = await loadRun(id);
    const started = Date.parse(run?.startedAt ?? '') || null;
    let last = started;
    for (const wt of run?.worktrees ?? []) {
      if (!existsSync(wt.path)) continue;
      try {
        const lines = (await git(['status', '--porcelain', '-uall'], wt.path)).split('\n').filter(Boolean);
        for (const l of lines.slice(0, 200)) last = Math.max(last ?? 0, await stat(join(wt.path, l.slice(3).trim().replace(/^"|"$/g, ''))).then((s) => s.mtimeMs, () => 0));
        const commit = Number(await git(['log', '-1', '--format=%ct'], wt.path).catch(() => '')) * 1000;
        if (commit > (last ?? 0)) last = commit;
      } catch { /* an unreadable worktree: what we have stands */ }
    }
    return last;
  }

  const status = async () => {
    const cards = await store.list();
    return { ...limit(), running: cards.filter((c) => c.status === 'running').length, enabled: dispatchEnabled };
  };

  return {
    tick, answer, stop, retry, resolveConflicts, attach, cleanupResearch, startResearch,
    /** The background agents as the last tick listed them; no new `claude agents` call. */
    agentEntries: () => lastEntries, details, diff, status, queue, lastActivity, run: loadRun, setLimits, limits: () => ({ ...cfg }),
    /** Resolves when no background review is in flight (for tests and graceful shutdown). */
    settled: async () => { while (inFlight.size) await Promise.all([...inFlight]); },
    setEnabled: (v) => { dispatchEnabled = Boolean(v); },
    start: () => { if (!timer) { timer = setInterval(tick, tickMs); tick(); } },
    shutdown: () => { clearInterval(timer); timer = null; },
  };
}

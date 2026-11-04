import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { AFTER_KINDS, ConfirmationError, NotFoundError, PRIORITIES, ValidationError, normalizeBranch } from './cards.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { branchStatus, git, readGit, resolveBase, samePath, switchableBranches, switchBranch as gitSwitch } from './git.js';
import { parseEffort, parseModel } from './models.js';
import { createRepos } from './repos.js';
import { addUsage, usageFromResult } from './usage.js';

export const PROJECT_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One-line summary of the project' },
    plan: { type: 'string', description: 'Project plan in Markdown, saved as PLAN.md at the repository root: goal, scope and non-goals, architecture, technology choices with a reason each, how it is built, tested and run, milestones, risks and open questions' },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 15,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative title, at most 80 characters' },
          brief: { type: 'string', description: 'Self-contained ticket: what to build, acceptance criteria, and the PLAN.md section it implements' },
          priority: { type: 'string', enum: PRIORITIES },
          after: { type: 'integer', minimum: 0, description: '0-based index of an EARLIER task this one depends on. Omit when the task can start right away.' },
          repos: { type: 'array', items: { type: 'string' }, description: 'Only for a project over several repositories: the names of the repositories this task changes (one or more). Default: all of them.' },
          afterKind: { type: 'string', enum: AFTER_KINDS, description: 'With `after`: "done" when this task needs that task implemented first, "planned" when it only needs that task\'s design decided (its plan approved), so both can be built in parallel. Default "done".' },
        },
        required: ['title', 'brief', 'priority'],
      },
    },
  },
  required: ['summary', 'plan', 'tasks'],
};

const SYSTEM_PROMPT = [
  'You plan a new software project for a ticket pipeline: coding agents implement one ticket at a time, each in its own git worktree and pull request.',
  'You never change anything. The repository is new and nearly empty, so plan from the description.',
  'Write the plan so an engineer who has not seen this conversation could follow it: goal, scope and non-goals, architecture, technology choices with a one-line reason each, how it is built, tested and run, milestones, risks and open questions.',
  'Split the work into tasks one agent can finish and verify in one sitting. The first task sets up the skeleton: build, test runner, and a README on how to run it.',
  'Every brief must stand on its own: the agent sees only its ticket and the repository, where the plan will be committed as PLAN.md. Include acceptance criteria.',
  'Use `after` only for real dependencies, so independent tasks can run in parallel. Say with `afterKind` whether a task needs the other one implemented ("done") or only designed ("planned").',
  'Write in the language of the description. Your final reply must be the structured output and nothing else.',
].join('\n');

const WORKSPACE_PROMPT = [
  'You plan work for a ticket pipeline over several existing repositories that belong to one product: coding agents implement one ticket at a time, each in its own git worktree and pull request, in the repositories the ticket names.',
  'You never change anything. Read the code in every repository that matters before planning: find out what is already there, how the repositories relate (APIs, shared types, contracts) and what the quickest sound way to the goal is, reusing what exists instead of rebuilding it.',
  'Write the plan so an engineer who has not seen this conversation could follow it: goal, what exists today and where (name the files), the chosen approach and why it is the fastest sound one, what each repository changes, how it is tested, risks and open questions.',
  'Split the work into tasks one agent can finish and verify in one sitting. Give every task `repos`: the repository names it changes. A change that needs several repositories to move together is one task per repository, ordered with `after` where the contract must exist first.',
  'Every brief must stand on its own: the agent sees only its ticket and its repositories. Include acceptance criteria and the files to start from.',
  'Use `after` only for real dependencies, so independent tasks can run in parallel. Say with `afterKind` whether a task needs the other one implemented ("done") or only designed ("planned").',
  'Write in the language of the description. Your final reply must be the structured output and nothing else.',
].join('\n');

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const BLOCKED_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/** The vulnerability audit of a project: off by default, then once a day. The interval is in minutes. */
export const AUDIT_DEFAULT = { enabled: false, everyMin: 1440 };
export const AUDIT_MIN = 5;
export const AUDIT_MAX = 525_600; // a year
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * New projects: a git repository under the repos root whose source control is local only or GitHub, then a plan
 * (PLAN.md) and tasks that Claude writes from the person's description, which become Inbox cards.
 * Steps: remote (GitHub not set up yet) -> describe -> planning -> review -> done.
 * A project can also be added from an existing git folder anywhere on disk (`imported`): its step is `existing`,
 * and AgentControl never deletes its folder. One over several repositories may still be planned from a description.
 */
export function createProjects({ dataDir, reposRoot, repos = createRepos({ reposRoot, dataDir }), store, claude, github, model = null, effort = null, ledger = null, log = () => {}, mapOf = async () => null }) {
  const projectsDir = join(dataDir, 'projects');
  const file = (name) => join(projectsDir, name, 'project.json');
  const locks = new Set();
  const planning = new Set();
  const activity = new Map(); // project -> what the planner did last, shown while it runs
  const inFlight = new Set();

  async function load(name) {
    if (!NAME_RE.test(name)) throw new NotFoundError(`Project ${name} not found`);
    const p = await readJson(file(name), null);
    if (!p) throw new NotFoundError(`Project ${name} not found`);
    p.model ??= null; // projects made before the model could be chosen
    p.effort ??= null;
    p.baseBranches ??= {}; // repository -> the branch its cards fork from and go back into; missing = the default branch
    p.audit = { ...AUDIT_DEFAULT, ...p.audit }; // projects made before the vulnerability audit existed
    p.hidden = p.hidden === true;
    if (p.planning.state === 'running' && !planning.has(name)) { // cut off by a restart
      p.planning.state = p.planning.plan ? 'ready' : 'error';
      p.planning.error = 'Suunnittelu keskeytyi, kun AgentControl käynnistettiin uudelleen. Käynnistä se uudelleen.';
    }
    return p;
  }
  const save = (p) => { p.updatedAt = new Date().toISOString(); return writeJsonAtomic(file(p.name), p); };

  function stepOf(p) {
    if (p.sourceControl.kind === 'github' && !p.sourceControl.pushed) return 'remote';
    if (p.imported && !p.workspace) return 'existing';
    if (p.planning.state === 'running') return 'planning';
    if (p.cards.length) return 'done';
    if (p.planning.state === 'ready') return 'review';
    return p.imported ? 'existing' : 'describe'; // added repositories already have their code: a plan is optional
  }
  const view = (p) => ({ ...p, step: stepOf(p), activity: activity.get(p.name) ?? null });

  /**
   * Shows the planning on the board as the project's own card: refining while Claude plans, needs_input while
   * the plan (or a failed run) waits for the person, done once the task cards exist. An archived card stays put.
   */
  async function syncCard(p) {
    const s = p.planning;
    const status = p.cards.length ? 'done' : s.state === 'running' ? 'refining' : s.state === 'idle' ? null : 'needs_input';
    if (!status) return;
    if (!p.planCard) {
      const card = await store.create({ title: `Projektin suunnitelma: ${p.name}`, brief: p.description, repos: [p.name], priority: 'high', project: p.name });
      p.planCard = card.id;
      await save(p);
    }
    const card = await store.get(p.planCard).catch(() => null);
    if (!card || card.status === 'archive') return;
    const patch = {};
    if (card.status !== status) patch.status = status;
    if (card.brief !== p.description) patch.brief = p.description;
    if (Object.keys(patch).length) await store.update(card.id, patch);
  }

  /** At startup: projects planned before their card existed, or cut off by a restart, get their card in the right column. */
  async function syncCards() {
    for (const p of await list()) {
      if (planning.has(p.name) || locks.has(p.name)) continue;
      try { await syncCard(await load(p.name)); } catch (e) { console.error(`project ${p.name}: card:`, e.message); }
    }
  }

  async function withLock(name, fn) {
    if (locks.has(name) || planning.has(name)) throw new ValidationError(`Project ${name} is busy; try again in a moment`);
    locks.add(name);
    try { return await fn(); } finally { locks.delete(name); }
  }

  async function create(input = {}) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME_RE.test(name) || WINDOWS_RESERVED.test(name) || /(\.|\.git)$/i.test(name)) {
      throw new ValidationError('Name: up to 100 letters A-Z, digits, ".", "_" or "-", starting with a letter or digit');
    }
    const sourceControl = parseSourceControl(input.sourceControl);
    const chosen = { model: parseModel(input.model) ?? null, effort: parseEffort(input.effort) ?? null };
    return withLock(name, async () => {
      if (existsSync(file(name))) throw new ValidationError(`Project ${name} already exists`);
      const path = join(reposRoot, name);
      await mkdir(reposRoot, { recursive: true });
      try {
        await mkdir(path); // fails when anything is there already
      } catch (e) {
        if (e.code === 'EEXIST') throw new ValidationError(`${path} already exists; choose another name`);
        throw e;
      }
      try {
        await git(['init', '-q', '-b', 'main'], path);
        await writeFile(join(path, 'README.md'), `# ${name}\n`, 'utf8');
        await git(['add', 'README.md'], path);
        await git(['commit', '-q', '-m', 'Initial commit'], path);
      } catch (e) {
        await rm(path, { recursive: true, force: true }); // only the folder made a moment ago
        throw e;
      }
      const now = new Date().toISOString();
      const p = {
        name, path, sourceControl, ...chosen, description: '', cards: [], createdAt: now, updatedAt: now,
        planning: { state: 'idle', sessionId: null, summary: '', plan: '', tasks: [], cost: 0, error: null },
      };
      await save(p);
      log('project', `Projekti perustettu: ${name} (${path})`, { project: name });
      if (sourceControl.kind === 'github') await setUpGithub(p);
      return view(p);
    });
  }

  /**
   * Adds a project whose git repository already exists in `input.path` (the repository's root folder, anywhere on
   * disk). Nothing in the folder is changed. The name defaults to the folder's name and is what cards use as repo.
   */
  async function addExisting(input = {}) {
    const given = Array.isArray(input.paths) ? input.paths : [input.path];
    const raws = given.map((x) => (typeof x === 'string' ? x.trim().replace(/^"(.*)"$/, '$1') : '')).filter(Boolean);
    if (!raws.length || raws.some((x) => !isAbsolute(x))) throw new ValidationError('Give the full path of the project folder, e.g. C:\\code\\shop');
    let folders = [...new Set(raws.map((x) => resolve(x)))];
    let parent = null;
    for (const f of folders) if (!(await stat(f).catch(() => null))?.isDirectory()) throw new ValidationError(`Folder not found: ${f}`);
    if (folders.length === 1 && !(await git(['rev-parse', '--show-toplevel'], folders[0]).catch(() => null))) {
      const inner = await innerRepos(folders[0]); // not a repository itself: a folder of repositories becomes one project over all of them
      if (inner.length === 1) throw new ValidationError(`${folders[0]} is not a git repository itself, but it holds one: ${basename(inner[0])}. Add that folder as the project.`);
      if (inner.length > 1) {
        if (input.workspace !== true) {
          throw new ConfirmationError(`${folders[0]} is not a git repository itself, but it holds ${inner.length}: ${inner.map((x) => basename(x)).join(', ')}. Add them as one project whose planner reads all of them? Cards can then span them; nothing in the folders is changed.`, { workspace: true });
        }
        parent = folders[0];
        folders = inner;
      }
    }
    if (folders.length > 1) return addWorkspace(folders, input, parent);
    const path = folders[0];
    await ensureRepo(path, input.initGit === true);
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : projectNameFrom(basename(path));
    if (!NAME_RE.test(name) || WINDOWS_RESERVED.test(name) || /(\.|\.git)$/i.test(name)) {
      throw new ValidationError('Name: up to 100 letters A-Z, digits, ".", "_" or "-", starting with a letter or digit');
    }
    const chosen = { model: parseModel(input.model) ?? null, effort: parseEffort(input.effort) ?? null };
    return withLock(name, async () => {
      if (existsSync(file(name))) throw new ValidationError(`Project ${name} already exists; give this one another name`);
      const sameFolder = (await list()).find((x) => !x.workspace && existsSync(x.path) && samePath(x.path, path));
      if (sameFolder) throw new ValidationError(`${path} is already the project ${sameFolder.name}`);
      const underRoot = join(reposRoot, name);
      if (existsSync(underRoot) && !samePath(underRoot, path)) throw new ValidationError(`${underRoot} is another repository with this name; give this project another name`);
      const now = new Date().toISOString();
      const p = {
        name, path, imported: true, sourceControl: await detectSourceControl(path), ...chosen, description: '', cards: [], createdAt: now, updatedAt: now,
        planning: { state: 'idle', sessionId: null, summary: '', plan: '', tasks: [], cost: 0, error: null },
      };
      await save(p);
      repos.add(name, path);
      log('project', `Projekti lisätty olemassa olevasta kansiosta: ${name} (${path})`, { project: name });
      return view(p);
    });
  }

  /** `path` must be the root of a git repository with a commit; with `initGit` a missing repository or first commit is made, otherwise the person is asked. */
  async function ensureRepo(path, initGit) {
    const top = await git(['rev-parse', '--show-toplevel'], path).catch(() => null);
    if (top && !samePath(top, path)) throw new ValidationError(`${path} is inside the git repository ${top}. Choose that folder, the one that contains .git.`);
    if (!top) {
      if (!initGit) throw new ConfirmationError(`${path} is not a git repository yet. Create one here? Every file in the folder (except what .gitignore excludes) goes into the first commit, on branch main.`, { gitInit: true });
      await git(['init', '-q', '-b', 'main'], path);
    }
    if (!(await git(['rev-parse', '--verify', '--quiet', 'HEAD'], path).then(() => true, () => false))) {
      if (!initGit) throw new ConfirmationError(`${path} is a git repository without commits. Agents work from a commit, so make the first one now with every file in the folder (except what .gitignore excludes)?`, { gitInit: true });
      await git(['add', '-A'], path);
      await git(['commit', '-q', '--allow-empty', '-m', 'Initial commit'], path);
    }
  }

  /**
   * One project over several existing repositories (e.g. web, mobile and backend of one product). Its planner reads
   * all of them and its tasks name the repositories each card works in; each repository's name works as a card repo.
   * `parent` is the folder they were found in; it names the project unless `input.name` does.
   */
  async function addWorkspace(folders, input, parent) {
    for (const f of folders) await ensureRepo(f, input.initGit === true);
    const members = folders.map((path) => ({ name: projectNameFrom(basename(path)), path }));
    for (const m of members) {
      if (!NAME_RE.test(m.name) || WINDOWS_RESERVED.test(m.name) || /(\.|\.git)$/i.test(m.name)) throw new ValidationError(`${m.path}: the folder name cannot be used as a repo name`);
    }
    if (new Set(members.map((m) => m.name.toLowerCase())).size !== members.length) throw new ValidationError('Two of the folders have the same name; they would be the same repo for cards');
    const given = typeof input.name === 'string' ? input.name.trim() : '';
    if (!given && !parent) throw new ValidationError('Give the project a name: the folders are not in one parent folder');
    let name = given || projectNameFrom(basename(parent));
    if (!given && members.some((m) => m.name === name)) name = `${name}-workspace`;
    if (!NAME_RE.test(name) || WINDOWS_RESERVED.test(name) || /(\.|\.git)$/i.test(name)) {
      throw new ValidationError('Name: up to 100 letters A-Z, digits, ".", "_" or "-", starting with a letter or digit');
    }
    if (members.some((m) => m.name === name)) throw new ValidationError(`${name} is also the name of one of the repositories; give the project another name`);
    const chosen = { model: parseModel(input.model) ?? null, effort: parseEffort(input.effort) ?? null };
    return withLock(name, async () => {
      if (existsSync(file(name))) throw new ValidationError(`Project ${name} already exists; give this one another name`);
      const all = await list();
      for (const m of members) {
        const other = all.find((x) => x.name === m.name && !samePath(x.path, m.path));
        if (other) throw new ValidationError(`${m.name} is already the project of ${other.path}; give that project another name or remove it first`);
        const underRoot = join(reposRoot, m.name);
        // a plain folder of that name (the very folder the repositories were found in) is no clash: the name resolves to the repository
        if (existsSync(join(underRoot, '.git')) && !samePath(underRoot, m.path)) throw new ValidationError(`${underRoot} is another repository with the name ${m.name}`);
      }
      const now = new Date().toISOString();
      const p = {
        name, path: members[0].path, imported: true, workspace: true, workspaceRepos: members, sourceControl: { kind: 'local' }, ...chosen,
        description: '', cards: [], createdAt: now, updatedAt: now,
        planning: { state: 'idle', sessionId: null, summary: '', plan: '', tasks: [], cost: 0, error: null },
      };
      await save(p);
      repos.add(name, p.path);
      for (const m of members) repos.add(m.name, m.path);
      log('project', `Projekti lisätty ${members.length} repolle: ${name} (${members.map((m) => m.name).join(', ')})`, { project: name });
      return view(p);
    });
  }

  /** Creates the GitHub repository (once), points origin at it and pushes main. A failure stays on the project for the UI. */
  async function setUpGithub(p) {
    const sc = p.sourceControl;
    try {
      if (!sc.fullName) {
        Object.assign(sc, await github.createRepo({ owner: sc.owner, name: p.name, description: p.planning.summary, private: sc.private }));
        await save(p); // the repository exists now: never create it twice
      }
      if (!(await git(['remote'], p.path)).split('\n').includes('origin')) await git(['remote', 'add', 'origin', sc.cloneUrl], p.path);
      const origin = await git(['remote', 'get-url', 'origin'], p.path);
      if (origin !== sc.cloneUrl) throw new Error(`origin already points to ${origin}, not to ${sc.cloneUrl}`);
      await git(['push', '-u', 'origin', 'main'], p.path, { timeoutMs: 180_000 });
      await git(['remote', 'set-head', 'origin', 'main'], p.path).catch(() => {});
      sc.pushed = true;
      sc.error = null;
      log('project', `${p.name}: GitHub-repo ${sc.fullName} valmis, main pushattu`, { project: p.name });
    } catch (e) {
      if (!e.expose) console.error(`project ${p.name}: GitHub setup:`, e);
      sc.error = e.message;
      log('project', `${p.name}: GitHub-vaihe epäonnistui: ${e.message}`, { project: p.name, level: 'error' });
    }
    await save(p);
  }

  /** Sets up or retries GitHub, moves a local project to GitHub, or keeps it local while no GitHub repository exists yet. */
  async function setSourceControl(name, input = {}) {
    return withLock(name, async () => {
      const p = await load(name);
      const current = p.sourceControl;
      if (current.kind === 'remote') throw new ValidationError(`The project already has a remote (${current.url})`);
      if (current.kind === 'github' && current.pushed) throw new ValidationError('The project is already on GitHub');
      if (current.kind === 'github' && current.fullName) {
        if (input.sourceControl && input.sourceControl.kind !== 'github') throw new ValidationError(`The GitHub repository ${current.fullName} exists already; only the push can be retried`);
      } else {
        p.sourceControl = parseSourceControl(input.sourceControl ?? current);
      }
      if (p.sourceControl.kind === 'github') await setUpGithub(p);
      else await save(p);
      return view(p);
    });
  }

  /**
   * Chooses the model and effort for the project's agents (planner, refiners, implementation agents); a card's own
   * choice still wins. Give `model` and/or `effort`; an empty value goes back to the default. Refused while the
   * planner runs, which would write the project file over this change.
   */
  async function setSettings(name, input = {}) {
    const model = parseModel(input.model);
    const effort = parseEffort(input.effort);
    if (model === undefined && effort === undefined) throw new ValidationError('Give a model and/or an effort');
    return withLock(name, async () => {
      const p = await load(name);
      if (model !== undefined) p.model = model;
      if (effort !== undefined) p.effort = effort;
      await save(p);
      log('project', `${name}: malli ${p.model ?? 'oletus'}, effort ${p.effort ?? 'oletus'}`, { project: name });
      return view(p);
    });
  }

  /**
   * Hides the project from everywhere but the project list: its cards leave the board, the agents, the changes and
   * "your turn". Only what is shown changes; its agents, audits and cards go on as before.
   */
  async function setHidden(name, input = {}) {
    if (typeof input.hidden !== 'boolean') throw new ValidationError('hidden must be true or false');
    return withLock(name, async () => {
      const p = await load(name);
      p.hidden = input.hidden;
      await save(p);
      log('project', `${name}: ${p.hidden ? 'piilotettu' : 'näkyvissä taas'}`, { project: name });
      return view(p);
    });
  }

  /**
   * Whether a card belongs to hidden projects only: the planning card of a hidden project, or a card all of whose
   * repositories are in hidden projects (a repository that a shown project also has keeps the card shown).
   */
  async function hiddenCards() {
    const all = await list().catch(() => []);
    const hiddenNames = new Set(all.filter((p) => p.hidden).map((p) => p.name));
    if (!hiddenNames.size) return () => false;
    const reposOf = (p) => (p.workspace ? p.workspaceRepos.map((r) => r.name) : [p.name]);
    const shownRepos = new Set(all.filter((p) => !p.hidden).flatMap(reposOf));
    const hiddenRepos = new Set(all.filter((p) => p.hidden).flatMap(reposOf).filter((r) => !shownRepos.has(r)));
    return (c) => (c.project ? hiddenNames.has(c.project) : c.repos.length > 0 && c.repos.every((r) => hiddenRepos.has(r)));
  }

  /**
   * Turns the project's automatic vulnerability audit on or off and sets how often it runs (`everyMin`, in minutes).
   * Give either or both. Refused while the planner runs, like the model settings.
   */
  async function setAudit(name, input = {}) {
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new ValidationError('enabled must be true or false');
    const every = input.everyMin;
    if (every !== undefined && !(Number.isInteger(every) && every >= AUDIT_MIN && every <= AUDIT_MAX)) throw new ValidationError(`everyMin must be a whole number of minutes, ${AUDIT_MIN}-${AUDIT_MAX}`);
    if (input.enabled === undefined && every === undefined) throw new ValidationError('Give enabled and/or everyMin');
    return withLock(name, async () => {
      const p = await load(name);
      if (input.enabled !== undefined) p.audit.enabled = input.enabled;
      if (every !== undefined) p.audit.everyMin = every;
      await save(p);
      log('project', `${name}: haavoittuvuustarkastus ${p.audit.enabled ? `päällä, ${p.audit.everyMin} min välein` : 'pois päältä'}`, { project: name });
      return view(p);
    });
  }

  /** The latest commits (on the checked-out branch) of each repository of the project, newest first, with where the branch stands. */
  async function recentCommits(name, limit = 10) {
    const p = await load(name);
    const members = p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }];
    return Promise.all(members.map(async (m) => {
      const out = await git(['log', `-n${limit}`, '--format=%h%x1f%aI%x1f%an%x1f%s'], m.path).catch(() => '');
      return { repo: m.name, ...(await branchStatus(m.path, p.baseBranches[m.name])), commits: out.split('\n').filter(Boolean).map((l) => { const [sha, at, author, subject] = l.split('\x1f'); return { sha, at, author, subject }; }) };
    }));
  }

  /**
   * Where each repository of the project stands (see `branchStatus`), measured against its target branch (`target`,
   * the one its cards fork from; null = the default branch). With `fetch`, the remote is fetched first, so
   * "behind" and "to pull" are as of now; without it nothing leaves this machine.
   */
  async function branches(name, { fetch = false } = {}) {
    const p = await load(name);
    const members = p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }];
    return Promise.all(members.map(async (m) => {
      if (fetch) await git(['fetch', '--quiet', '--prune'], m.path, { timeoutMs: 30_000 }).catch(() => {}); // offline or no remote: what we have
      const target = p.baseBranches[m.name] ?? null;
      const [status, switchable] = await Promise.all([branchStatus(m.path, target), switchableBranches(m.path)]);
      return { repo: m.name, path: m.path, target, ...status, switchable };
    }));
  }

  /**
   * Chooses the branch that new work in repository `repo` of the project forks from and goes back into (pull request
   * target, local merge), e.g. features/maui-dev; empty goes back to the repository's default branch. A card's own
   * choice still wins. Cards already at work keep the branch they started from. Returns `branches` again.
   */
  async function setBase(name, input = {}) {
    const branch = normalizeBranch(input.branch ?? null);
    const updated = await withLock(name, async () => {
      const p = await load(name);
      const m = (p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }]).find((x) => x.name === input.repo);
      if (!m) throw new ValidationError(`No repository ${input.repo} in project ${name}`);
      if (branch) await resolveBase(m.path, branch);
      if (branch) p.baseBranches[m.name] = branch;
      else delete p.baseBranches[m.name];
      await save(p);
      log('project', `${name}: ${m.name} uusien korttien kohdehaara ${branch ?? 'oletushaara'}`, { project: name });
      return p;
    });
    return branches(updated.name);
  }

  /** The branch the project chose for repository `repo` (see `setBase`); null when none did or `repo` is in no project. */
  async function baseFor(repo) {
    if (typeof repo !== 'string' || !NAME_RE.test(repo)) return null;
    const own = await readJson(file(repo), null).catch(() => null); // an unreadable file must not stop an agent from starting
    if (own?.baseBranches?.[repo]) return own.baseBranches[repo];
    const workspaces = (await list().catch(() => [])).filter((x) => x.workspace && x.baseBranches?.[repo]);
    return workspaces[0]?.baseBranches[repo] ?? null;
  }

  /** Switches repository `repo` of the project to `branch` (see `switchBranch` in git.js) and returns `branches` again. */
  async function switchBranch(name, input = {}) {
    const p = await load(name);
    const m = (p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }]).find((x) => x.name === input.repo);
    if (!m) throw new ValidationError(`No repository ${input.repo} in project ${name}`);
    if (typeof input.branch !== 'string' || !input.branch) throw new ValidationError('branch is required');
    const { pulled } = await gitSwitch(m.path, input.branch);
    log('project', `${name}: ${m.name} vaihdettiin haaraan ${input.branch}${pulled ? `, ${pulled} committia haettu` : ''}`, { project: name });
    return branches(name);
  }

  /** One commit of the project: message, changed files and the change itself (cut when long), from whichever of its repositories has it. */
  async function commitDetails(name, sha) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{4,40}$/i.test(sha)) throw new ValidationError('sha must be 4-40 hexadecimal characters');
    const p = await load(name);
    for (const m of p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }]) {
      if (!(await git(['cat-file', '-e', `${sha}^{commit}`], m.path).then(() => true, () => false))) continue;
      const header = await git(['show', '--no-patch', '--format=%H%n%an%n%aI%n%B', sha], m.path);
      const stat = await git(['show', '--stat', '--format=', sha], m.path);
      const patch = await git(['show', '--format=', '--unified=2', sha], m.path);
      const [full, author, at, ...message] = header.split('\n');
      return { repo: m.name, sha: full, author, at, message: message.join('\n').trim(), stat, patch: patch.length > 12_000 ? `${patch.slice(0, 12_000)}\n… (${patch.length - 12_000} more characters)` : patch };
    }
    throw new NotFoundError(`Commit ${sha} not found in project ${name}`);
  }

  /** A read-only git command (see `checkReadOnlyGit`) in repository `repo` of the project (its only one when left out). */
  async function gitRead(name, { repo, args } = {}) {
    const p = await load(name);
    const members = p.workspace ? p.workspaceRepos : [{ name: p.name, path: p.path }];
    const m = repo ? members.find((x) => x.name === repo) : members.length === 1 ? members[0] : null;
    if (!m) throw new ValidationError(repo ? `No repository ${repo} in project ${name}` : `Project ${name} has several repositories: name one (${members.map((x) => x.name).join(', ')})`);
    return { repo: m.name, output: await readGit(args, m.path) };
  }

  /** The model and effort chosen for the project whose repository is `repo`; null for each that is unset or when `repo` is no project. */
  async function settingsFor(repo) {
    const none = { model: null, effort: null };
    if (typeof repo !== 'string' || !NAME_RE.test(repo)) return none;
    const own = await readJson(file(repo), null).catch(() => null); // an unreadable file must not stop an agent from starting
    const workspaces = (await list().catch(() => [])).filter((x) => x.workspace && x.workspaceRepos.some((r) => r.name === repo)); // projects over several repositories that include it
    const pick = (key) => own?.[key] ?? workspaces.find((x) => x[key])?.[key] ?? null;
    return { model: pick('model'), effort: pick('effort') };
  }

  /** Starts the planner in the background: from the description, or as a follow-up turn with feedback on the last plan. */
  async function plan(name, input = {}) {
    const p = await load(name);
    if (p.imported && !p.workspace) throw new ValidationError('Planning is for new projects; an added project already has its code. Make cards for it instead.');
    if (stepOf(p) === 'remote') throw new ValidationError('Finish setting up GitHub first, or keep the project local');
    if (p.cards.length) throw new ValidationError('Tasks were already created from this plan');
    const s = p.planning;
    const feedback = typeof input.feedback === 'string' ? input.feedback.trim() : '';
    let prompt;
    if (feedback) {
      if (s.state !== 'ready' || !s.sessionId) throw new ValidationError('There is no plan to give feedback on yet');
      prompt = `Feedback on the plan:\n${feedback}\n\nUpdate the plan and the tasks.`;
    } else {
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      if (!description) throw new ValidationError('Describe the project first');
      const where = p.sourceControl.kind === 'github'
        ? `GitHub repository ${p.sourceControl.fullName} (${p.sourceControl.private ? 'private' : 'public'}), cloned at ${p.path}`
        : `a local git repository at ${p.path}, with no remote`;
      const map = p.workspace ? await mapOf(p.name).catch(() => null) : null;
      if (p.workspace) {
        prompt = [
          `Project: ${p.name}`,
          `Repositories (read the code in each before planning); a task's \`repos\` uses these names:\n${p.workspaceRepos.map((r) => `- ${r.name}: ${r.path}`).join('\n')}`,
          `\nWhat is wanted:\n${description}`,
          map ? `\n## Code map from an earlier exploration (can lag behind the code; verify what you rely on)\n\n${map.text}` : '',
          '\nRead the relevant code, then write the plan and split the work into tasks.',
        ].filter(Boolean).join('\n');
      } else prompt = [
        `Project: ${p.name}`,
        `Source control: ${where}. It holds only README.md so far; the default branch is main.`,
        `\nDescription:\n${description}`,
        '\nWrite the project plan and split the work into tasks.',
      ].join('\n');
      Object.assign(p, { description });
      Object.assign(s, { sessionId: null, summary: '', plan: '', tasks: [] }); // a new description starts over
    }
    if (locks.has(name) || planning.has(name)) throw new ValidationError('Planning is already running for this project');
    planning.add(name); // no await since the check above, so two clicks cannot both start
    s.state = 'running';
    s.error = null;
    try {
      await save(p);
      await syncCard(p);
    } catch (e) {
      planning.delete(name);
      throw e;
    }
    log('project', feedback ? `${name}: suunnitelmaa päivitetään` : `${name}: suunnittelu alkoi`, { project: name });
    const done = runPlanner(p, prompt)
      .catch((e) => console.error(`plan ${name}:`, e.message))
      .finally(() => { planning.delete(name); activity.delete(name); inFlight.delete(done); });
    inFlight.add(done);
    return view(p);
  }

  async function runPlanner(p, prompt) {
    const s = p.planning;
    try {
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--json-schema', JSON.stringify(PROJECT_PLAN_SCHEMA),
        '--permission-mode', 'plan',
        '--allowedTools', ...READ_ONLY_TOOLS,
        '--disallowedTools', ...BLOCKED_TOOLS,
      ];
      if (p.workspace) for (const r of p.workspaceRepos.slice(1)) args.push('--add-dir', r.path); // the first one is the working directory
      args.push('--append-system-prompt', p.workspace ? WORKSPACE_PROMPT : SYSTEM_PROMPT);
      if (p.model ?? model) args.push('--model', p.model ?? model);
      if (p.effort ?? effort) args.push('--effort', p.effort ?? effort);
      if (s.sessionId) args.push('--resume', s.sessionId);
      const onEvent = (event) => { const a = describeEvent(event); if (a) activity.set(p.name, a); };
      const result = await claude.run({ args, cwd: p.path, prompt, onEvent });
      s.cost = round(s.cost + (result.total_cost_usd ?? 0));
      s.usage = addUsage(s.usage, usageFromResult(result));
      ledger?.record('planner', usageFromResult(result), { project: p.name });
      const out = result.structured_output;
      if (result.is_error || !out || typeof out !== 'object') throw new Error(result.result || `claude returned no structured output (${result.subtype ?? 'unknown'})`);
      const tasks = normalizeTasks(out.tasks);
      const planText = String(out.plan ?? '').trim();
      if (!planText || !tasks.length) throw new Error('The planner returned an empty plan or no tasks');
      Object.assign(s, { sessionId: result.session_id ?? s.sessionId, summary: String(out.summary ?? '').trim(), plan: planText, tasks, state: 'ready', error: null });
      log('project', `${p.name}: suunnitelma valmis, ${tasks.length} tehtävää odottaa hyväksyntääsi`, { project: p.name, level: 'warn' });
    } catch (e) {
      s.state = s.plan ? 'ready' : 'error'; // a failed feedback turn keeps the plan it was about
      s.error = e.message;
      log('project', `${p.name}: suunnittelu epäonnistui: ${e.message}`, { project: p.name, level: 'error' });
    }
    await save(p);
    await syncCard(p);
  }

  /** Commits the plan as PLAN.md (and pushes it when the project is on GitHub), then turns the chosen tasks into Inbox cards. */
  async function createTasks(name, input = {}) {
    return withLock(name, async () => {
      const p = await load(name);
      if (p.cards.length) throw new ValidationError('Tasks were already created from this plan');
      if (p.planning.state !== 'ready') throw new ValidationError('There is no finished plan yet');
      const tasks = p.planning.tasks;
      const chosen = input.tasks ?? tasks.map((_, i) => i);
      if (!Array.isArray(chosen) || chosen.some((i) => !Number.isInteger(i) || i < 0 || i >= tasks.length)) {
        throw new ValidationError('tasks must be a list of task numbers from the plan');
      }
      if (!chosen.length) throw new ValidationError('Choose at least one task');

      if (p.workspace) { // no repository of its own: the plan stays with the project
        await writeFile(join(projectsDir, p.name, 'PLAN.md'), `${p.planning.plan}\n`, 'utf8');
      } else {
        const branch = await git(['symbolic-ref', '--short', 'HEAD'], p.path);
        if (branch !== 'main') throw new ValidationError(`PLAN.md is committed to main, but ${p.path} is on branch ${branch}`);
        await writeFile(join(p.path, 'PLAN.md'), `${p.planning.plan}\n`, 'utf8');
        await git(['add', 'PLAN.md'], p.path);
        if (await git(['diff', '--cached', '--name-only', '--', 'PLAN.md'], p.path)) await git(['commit', '-q', '-m', 'Add project plan', '--', 'PLAN.md'], p.path);
        if (p.sourceControl.kind === 'github') await git(['push', 'origin', 'main'], p.path, { timeoutMs: 180_000 });
      }
      const known = p.workspace ? p.workspaceRepos.map((r) => r.name) : [p.name];

      const ids = new Map();
      for (const i of [...new Set(chosen)].sort((a, b) => a - b)) {
        let dep = tasks[i].after;
        while (dep != null && !ids.has(dep)) dep = tasks[dep].after; // a skipped task: wait for what it waited for
        const t = tasks[i];
        const card = await store.create({
          title: t.title, brief: t.brief, repos: p.workspace ? (t.repos?.filter((r) => known.includes(r)).length ? t.repos.filter((r) => known.includes(r)) : known) : [p.name], priority: t.priority,
          after: dep == null ? null : ids.get(dep), afterKind: t.afterKind ?? 'done',
        });
        ids.set(i, card.id);
        p.cards.push(card.id);
      }
      await save(p);
      await syncCard(p);
      log('project', `${p.name}: PLAN.md tallennettu ja ${ids.size} korttia luotu Inboxiin`, { project: p.name });
      return view(p);
    });
  }

  async function list() {
    let names;
    try {
      names = await readdir(projectsDir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const name of names) {
      try {
        out.push(view(await load(name)));
      } catch (e) {
        if (!(e instanceof NotFoundError)) console.error(`Skipping unreadable project ${name}:`, e.message);
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Takes a project out of AgentControl: its cards (tasks and planning card) go to the archive, and with
   * `deleteFolder` its local repository folder and the cards' worktrees are deleted too. A GitHub repository is
   * never touched. Refused while one of its agents works.
   */
  async function remove(name, { deleteFolder = false } = {}) {
    return withLock(name, async () => {
      const p = await load(name);
      if (p.imported && deleteFolder) throw new ValidationError(`${p.path} was added from an existing folder, so AgentControl does not delete it. Remove the project without deleting the folder.`);
      const ids = [...p.cards, ...(p.planCard ? [p.planCard] : [])];
      const cards = (await store.list()).filter((c) => ids.includes(c.id) || c.repos.includes(p.name));
      const busy = cards.filter((c) => c.status === 'running');
      if (busy.length) throw new ValidationError(`Stop the agents first: ${busy.map((c) => c.title).join(', ')}`);
      for (const c of cards.filter((x) => ids.includes(x.id) && x.status !== 'archive')) await store.update(c.id, { status: 'archive' });
      if (deleteFolder) {
        const folder = join(reposRoot, p.name);
        if (p.path !== folder) throw new ValidationError(`The project folder ${p.path} is not ${folder}; delete it by hand`);
        await rm(folder, { recursive: true, force: true });
        for (const c of cards) {
          await rm(join(dataDir, 'worktrees', c.id, p.name), { recursive: true, force: true });
          await rm(join(dataDir, 'refine-checkouts', c.id, p.name), { recursive: true, force: true });
        }
      }
      await rm(join(projectsDir, p.name), { recursive: true, force: true });
      repos.remove(p.name);
      if (p.workspace) { // the repositories stay known while another project still uses them
        const others = (await list()).filter((x) => x.name !== p.name);
        for (const m of p.workspaceRepos) if (!others.some((x) => x.name === m.name || x.workspaceRepos?.some((r) => r.name === m.name))) repos.remove(m.name);
      }
      log('project', `Projekti poistettu: ${p.name}${deleteFolder ? ` (myös kansio ${p.path})` : ''}`, { project: p.name });
      return { removed: p.name, archived: cards.filter((c) => ids.includes(c.id)).length, folderDeleted: deleteFolder };
    });
  }

  /** Resolves when no planner is running (for tests). */
  const settled = async () => { while (inFlight.size) await Promise.all([...inFlight]); };

  return { list, get: async (name) => view(await load(name)), create, addExisting, setSourceControl, setSettings, setAudit, setHidden, hiddenCards, recentCommits, branches, switchBranch, setBase, baseFor, commitDetails, gitRead, settingsFor, plan, createTasks, syncCards, remove, settled, busy: () => [...planning] };
}

function parseSourceControl(input) {
  const kind = input?.kind ?? 'local';
  if (kind === 'local') return { kind: 'local' };
  if (kind !== 'github') throw new ValidationError('sourceControl.kind must be local or github');
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  if (owner && !OWNER_RE.test(owner)) throw new ValidationError(`Invalid GitHub owner: ${owner}`);
  return { kind: 'github', owner: owner || null, private: input.private !== false, fullName: null, url: null, cloneUrl: null, pushed: false, error: null };
}

/** The git repositories directly inside `path`, as full paths. */
async function innerRepos(path) {
  const found = [];
  for (const d of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory() && existsSync(join(path, d.name, '.git'))) found.push(join(path, d.name));
  }
  return found;
}

/** A folder name as a project name: other characters become "-", and it must start with a letter or digit. */
function projectNameFrom(folder) {
  return folder.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/[-.]+$/, '').slice(0, 100);
}

/** What an existing repository's origin says about where its code lives: GitHub, some other remote, or nowhere. */
async function detectSourceControl(path) {
  const origin = await git(['remote', 'get-url', 'origin'], path).catch(() => '');
  if (!origin) return { kind: 'local' };
  const url = origin.replace(/\/\/[^@/]*@/, '//'); // never keep credentials that are part of the address
  const gh = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!gh) return { kind: 'remote', url };
  return { kind: 'github', owner: gh[1], private: null, fullName: `${gh[1]}/${gh[2]}`, url: `https://github.com/${gh[1]}/${gh[2]}`, cloneUrl: url, pushed: true, error: null };
}

/** Keeps well-formed tasks; `after` must point to an earlier kept task, re-indexed when malformed ones are dropped. */
function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  const out = [];
  const index = new Map();
  tasks.slice(0, 30).forEach((t, i) => {
    const title = String(t?.title ?? '').trim().slice(0, 200);
    if (!title) return;
    const after = Number.isInteger(t.after) && t.after < i ? index.get(t.after) ?? null : null;
    index.set(i, out.length);
    const afterKind = after == null ? null : AFTER_KINDS.includes(t.afterKind) ? t.afterKind : 'done';
    const task = { title, brief: String(t.brief ?? '').trim(), priority: PRIORITIES.includes(t.priority) ? t.priority : 'normal', after, afterKind };
    if (Array.isArray(t.repos)) task.repos = [...new Set(t.repos.filter((r) => typeof r === 'string').map((r) => r.trim()))].slice(0, 10);
    out.push(task);
  });
  return out;
}

function describeEvent(event) {
  if (event.type !== 'assistant') return null;
  let last = null;
  for (const b of event.message?.content ?? []) {
    if (b.type === 'tool_use' && b.name !== 'StructuredOutput') {
      const first = Object.values(b.input ?? {}).find((v) => typeof v === 'string') ?? '';
      last = `${b.name}: ${first.slice(0, 120)}`;
    } else if (b.type === 'text' && b.text?.trim()) {
      last = b.text.trim().slice(0, 200);
    }
  }
  return last;
}

function round(n) { return Math.round(n * 1e4) / 1e4; }

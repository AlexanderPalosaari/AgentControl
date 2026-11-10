import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';
import { createGithub, createGithubToken } from '../lib/github.js';

const fake = fileURLToPath(new URL('./fake-planner.js', import.meta.url));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const token = 't';
const headers = { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' };

let dir, data, reposRoot, logFile, ghServer, ghRequests, server, base;
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const invocations = async () => (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const bare = (name) => join(dir, 'github', `${name}.git`);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-projects-'));
  data = join(dir, 'data');
  reposRoot = join(dir, 'repos');
  await mkdir(join(dir, 'github'), { recursive: true });
  logFile = join(dir, 'fake.log');
  process.env.FAKE_LOG = logFile;
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });

  // A tiny stand-in for the GitHub REST API. A created repository is a local bare repo, so the push really happens.
  ghRequests = [];
  ghServer = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      ghRequests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (ghServer.reject) return send(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
      if (req.method === 'GET' && req.url === '/user') return send(200, { login: 'me' });
      const m = req.url.match(/^\/(?:user|orgs\/([^/]+))\/repos$/);
      if (req.method !== 'POST' || !m) return send(404, { message: 'Not Found' });
      const b = JSON.parse(body);
      sh(join(dir, 'github'), 'init', '-q', '--bare', '-b', 'main', `${b.name}.git`);
      const owner = m[1] ?? 'me';
      return send(201, { full_name: `${owner}/${b.name}`, html_url: `https://github.com/${owner}/${b.name}`, clone_url: bare(b.name), private: b.private });
    });
  });
  await new Promise((r) => ghServer.listen(0, '127.0.0.1', r));

  server = createApp({
    dataDir: data, token, reposRoot,
    claude: createClaude({ command: process.execPath, prefixArgs: [fake] }),
    github: createGithub({ getToken: async () => 'gh-token', apiBase: `http://127.0.0.1:${ghServer.address().port}` }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => ghServer.close(r));
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => { ghServer.reject = false; ghRequests.length = 0; });

describe('creating a project', () => {
  test('a local project is a git repository with a first commit on main and no remote', async () => {
    const res = await call('POST', '/api/projects', { name: 'portal' });
    assert.equal(res.status, 201);
    assert.equal(res.body.step, 'describe');
    assert.deepEqual(res.body.sourceControl, { kind: 'local' });
    const path = join(reposRoot, 'portal');
    assert.equal(res.body.path, path);
    assert.equal(sh(path, 'branch', '--show-current'), 'main');
    assert.equal(sh(path, 'log', '--format=%s'), 'Initial commit');
    assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), '# portal\n');
    assert.equal(sh(path, 'remote'), '');
    assert.equal(ghRequests.length, 0, 'GitHub is not contacted');
    assert.ok((await call('GET', '/api/repos')).body.includes('portal'), 'the repo can be picked for cards');
    assert.equal((await call('GET', '/api/projects')).body[0].name, 'portal');
  });

  test('bad names are refused', async () => {
    for (const name of ['', '../x', 'a b', 'con', 'x.git', 'ends.', '-x', 'ä']) {
      const res = await call('POST', '/api/projects', { name });
      assert.equal(res.status, 400, name);
    }
  });

  test('an existing folder is never reused or removed', async () => {
    await mkdir(join(reposRoot, 'taken'), { recursive: true });
    writeFileSync(join(reposRoot, 'taken', 'keep.txt'), 'mine');
    const res = await call('POST', '/api/projects', { name: 'taken' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /already exists/);
    assert.equal(readFileSync(join(reposRoot, 'taken', 'keep.txt'), 'utf8'), 'mine');
    assert.ok(!existsSync(join(reposRoot, 'taken', '.git')));
  });

  test('a GitHub project creates the repository, sets origin and pushes main', async () => {
    const res = await call('POST', '/api/projects', { name: 'shop', sourceControl: { kind: 'github', private: true } });
    assert.equal(res.status, 201);
    assert.equal(res.body.step, 'describe');
    const sc = res.body.sourceControl;
    assert.equal(sc.kind, 'github');
    assert.equal(sc.fullName, 'me/shop');
    assert.equal(sc.url, 'https://github.com/me/shop');
    assert.equal(sc.pushed, true);
    assert.equal(sc.error, null);
    const post = ghRequests.find((r) => r.method === 'POST');
    assert.equal(post.path, '/user/repos');
    assert.equal(post.auth, 'Bearer gh-token');
    assert.deepEqual(post.body, { name: 'shop', description: '', private: true, auto_init: false });
    const path = join(reposRoot, 'shop');
    assert.equal(sh(path, 'remote', 'get-url', 'origin'), bare('shop'));
    assert.equal(sh(bare('shop'), 'log', '--format=%s', 'main'), 'Initial commit');
  });

  test('an organization owner creates the repository in that organization', async () => {
    const res = await call('POST', '/api/projects', { name: 'orgapp', sourceControl: { kind: 'github', owner: 'acme', private: false } });
    assert.equal(res.body.sourceControl.fullName, 'acme/orgapp');
    assert.equal(res.body.sourceControl.private, false);
    assert.ok(ghRequests.some((r) => r.method === 'POST' && r.path === '/orgs/acme/repos'));
  });

  test('a GitHub failure keeps the local repository and can be retried or turned local', async () => {
    ghServer.reject = true;
    const res = await call('POST', '/api/projects', { name: 'flaky', sourceControl: { kind: 'github' } });
    assert.equal(res.status, 201, 'the local project exists either way');
    assert.equal(res.body.step, 'remote');
    assert.match(res.body.sourceControl.error, /name already exists/);
    assert.ok(existsSync(join(reposRoot, 'flaky', '.git')));
    assert.equal((await call('POST', '/api/projects/flaky/plan', { description: 'x' })).status, 400, 'planning waits for the source control step');

    ghServer.reject = false;
    const retried = await call('POST', '/api/projects/flaky/source-control', {});
    assert.equal(retried.body.step, 'describe');
    assert.equal(retried.body.sourceControl.pushed, true);

    ghServer.reject = true;
    await call('POST', '/api/projects', { name: 'stays-local', sourceControl: { kind: 'github' } });
    const local = await call('POST', '/api/projects/stays-local/source-control', { sourceControl: { kind: 'local' } });
    assert.equal(local.body.step, 'describe');
    assert.deepEqual(local.body.sourceControl, { kind: 'local' });
  });

  test('a local project can be moved to GitHub later', async () => {
    await call('POST', '/api/projects', { name: 'later' });
    const res = await call('POST', '/api/projects/later/source-control', { sourceControl: { kind: 'github' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.sourceControl.pushed, true);
    assert.equal(sh(bare('later'), 'log', '--format=%s', 'main'), 'Initial commit');
    assert.equal((await call('POST', '/api/projects/later/source-control', {})).status, 400, 'already on GitHub');
  });

  test('a duplicate project is refused', async () => {
    await call('POST', '/api/projects', { name: 'twice' });
    assert.equal((await call('POST', '/api/projects', { name: 'twice' })).status, 400);
  });
});

describe('planning and tasks', () => {
  test('the description becomes a plan and tasks; feedback resumes the same session', async () => {
    await call('POST', '/api/projects', { name: 'plan-me' });
    assert.equal((await call('POST', '/api/projects/plan-me/plan', {})).status, 400, 'a description is required');

    const started = await call('POST', '/api/projects/plan-me/plan', { description: 'Tilausportaali pienyrityksille' });
    assert.equal(started.status, 202);
    assert.equal(started.body.step, 'planning');
    await server.projects.settled();

    let p = (await call('GET', '/api/projects/plan-me')).body;
    assert.equal(p.step, 'review');
    assert.equal(p.description, 'Tilausportaali pienyrityksille');
    assert.equal(p.planning.plan, '# Suunnitelma\nSQLite.');
    assert.deepEqual(p.planning.tasks.map((t) => [t.title, t.after]), [['Runko', null], ['Tilaukset', 0], ['Raportit', 1]], 'the untitled task is dropped and indexes follow');
    assert.equal(p.planning.cost, 0.02);

    const first = (await invocations()).at(-1);
    assert.equal(first.cwd, join(reposRoot, 'plan-me'));
    assert.equal(first.args[first.args.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(first.args.includes('--json-schema'));
    assert.ok(!first.args.includes('--resume'));
    assert.match(first.prompt, /Source control: a local git repository at .*plan-me, with no remote/);
    assert.match(first.prompt, /Description:\nTilausportaali pienyrityksille/);

    assert.equal((await call('POST', '/api/projects/plan-me/plan', { feedback: 'Käytä PostgreSQL:ää' })).status, 202);
    await server.projects.settled();
    p = (await call('GET', '/api/projects/plan-me')).body;
    assert.equal(p.planning.plan, '# Suunnitelma v2\nPostgreSQL.');
    const second = (await invocations()).at(-1);
    assert.equal(second.args[second.args.indexOf('--resume') + 1], 'plan-session');
    assert.match(second.prompt, /Feedback on the plan:\nKäytä PostgreSQL:ää/);
  });

  test('chosen tasks become Inbox cards after PLAN.md is committed; a skipped task passes its dependency on', async () => {
    await call('POST', '/api/projects', { name: 'cards-me', sourceControl: { kind: 'github' } });
    await call('POST', '/api/projects/cards-me/plan', { description: 'Jotain' });
    await server.projects.settled();

    const res = await call('POST', '/api/projects/cards-me/tasks', { tasks: [0, 2] });
    assert.equal(res.status, 201);
    assert.equal(res.body.step, 'done');
    assert.equal(res.body.cards.length, 2);
    const [runko, raportit] = await Promise.all(res.body.cards.map(async (id) => (await call('GET', `/api/cards/${id}`)).body));
    assert.equal(runko.title, 'Runko');
    assert.deepEqual(runko.deps, []);
    assert.equal(runko.priority, 'high');
    assert.deepEqual(runko.repos, ['cards-me']);
    assert.equal(runko.status, 'inbox');
    assert.equal(raportit.title, 'Raportit');
    assert.deepEqual(raportit.deps.map((d) => d.id), [runko.id], 'Raportit waited for Tilaukset, which waited for Runko');

    const path = join(reposRoot, 'cards-me');
    assert.equal(readFileSync(join(path, 'PLAN.md'), 'utf8'), '# Suunnitelma\nSQLite.\n');
    assert.equal(sh(path, 'log', '-1', '--format=%s'), 'Add project plan');
    assert.equal(sh(bare('cards-me'), 'log', '-1', '--format=%s', 'main'), 'Add project plan', 'pushed to GitHub');

    const planCard = (await call('GET', `/api/cards/${res.body.planCard}`)).body;
    assert.equal(planCard.status, 'done', 'the planning card is done once the tasks exist');
    assert.equal(planCard.project, 'cards-me');
    assert.equal((await call('POST', '/api/projects/cards-me/tasks', {})).status, 400, 'cards are created only once');
    assert.equal((await call('POST', '/api/projects/cards-me/plan', { feedback: 'more' })).status, 400);
  });

  test('a failed planner run is reported and can be run again', async () => {
    await call('POST', '/api/projects', { name: 'fails' });
    await call('POST', '/api/projects/fails/plan', { description: 'FAIL please' });
    await server.projects.settled();
    let p = (await call('GET', '/api/projects/fails')).body;
    assert.equal(p.step, 'describe');
    assert.equal(p.planning.state, 'error');
    assert.match(p.planning.error, /simulated crash/);
    assert.equal((await call('POST', '/api/projects/fails/tasks', {})).status, 400);

    await call('POST', '/api/projects/fails/plan', { description: 'now it works' });
    await server.projects.settled();
    p = (await call('GET', '/api/projects/fails')).body;
    assert.equal(p.step, 'review');
    assert.equal(p.planning.error, null);
  });

  test('a second planning request while one runs is refused', async () => {
    await call('POST', '/api/projects', { name: 'busy' });
    assert.equal((await call('POST', '/api/projects/busy/plan', { description: 'SLOW' })).status, 202);
    const again = await call('POST', '/api/projects/busy/plan', { description: 'SLOW' });
    assert.equal(again.status, 400);
    assert.equal((await call('POST', '/api/projects/busy/source-control', { sourceControl: { kind: 'github' } })).status, 400);
    await server.projects.settled();
    assert.equal((await call('GET', '/api/projects/busy')).body.step, 'review');
  });

  test('planning shows on the board as the project\'s card: refining, then waiting for the person', async () => {
    await call('POST', '/api/projects', { name: 'on-board' });
    const started = await call('POST', '/api/projects/on-board/plan', { description: 'SLOW board' });
    const card = (await call('GET', `/api/cards/${started.body.planCard}`)).body;
    assert.equal(card.status, 'refining');
    assert.equal(card.title, 'Projektin suunnitelma: on-board');
    assert.equal(card.brief, 'SLOW board');
    assert.deepEqual(card.repos, ['on-board']);
    await server.projects.settled();
    assert.equal((await call('GET', `/api/cards/${card.id}`)).body.status, 'needs_input', 'the plan waits for approval');

    await server.store.update(card.id, { status: 'archive' });
    await call('POST', '/api/projects/on-board/plan', { feedback: 'more' });
    await server.projects.settled();
    assert.equal((await call('GET', `/api/cards/${card.id}`)).body.status, 'archive', 'an archived card is left alone');
    assert.equal((await call('GET', '/api/projects/on-board')).body.planCard, card.id, 'one card per project');
  });

  test('a failed planning run also waits for the person on the board', async () => {
    await call('POST', '/api/projects', { name: 'fails-on-board' });
    const started = await call('POST', '/api/projects/fails-on-board/plan', { description: 'FAIL' });
    await server.projects.settled();
    assert.equal((await call('GET', `/api/cards/${started.body.planCard}`)).body.status, 'needs_input');
  });

  test('the project list counts the agents working on each project', async () => {
    await call('POST', '/api/projects', { name: 'counted' });
    const listed = async () => (await call('GET', '/api/projects')).body.find((p) => p.name === 'counted');
    assert.equal((await listed()).activeAgents, 0);
    const running = (await call('POST', '/api/cards', { title: 'R', repos: ['counted'] })).body;
    await server.store.update(running.id, { status: 'running' });
    await call('POST', '/api/cards', { title: 'idle', repos: ['counted'] });
    await call('POST', '/api/projects/counted/plan', { description: 'SLOW' });
    assert.equal((await listed()).activeAgents, 2, 'one implementation agent and the planner');
    await server.projects.settled();
    assert.equal((await listed()).activeAgents, 1);
    await server.store.update(running.id, { status: 'review' });
  });

  test('deleting a project archives its cards and keeps the folder unless asked', async () => {
    await call('POST', '/api/projects', { name: 'goner' });
    await call('POST', '/api/projects/goner/plan', { description: 'x' });
    await server.projects.settled();
    const { cards: ids, planCard } = (await call('POST', '/api/projects/goner/tasks', { tasks: [0] })).body;
    const res = await call('POST', '/api/projects/goner/delete', {});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { removed: 'goner', archived: 2, folderDeleted: false });
    for (const id of [...ids, planCard]) assert.equal((await call('GET', `/api/cards/${id}`)).body.status, 'archive');
    assert.equal((await call('GET', '/api/projects/goner')).status, 404);
    assert.ok(existsSync(join(reposRoot, 'goner', '.git')), 'the repository folder stays');
  });

  test('deleting with the folder removes the repository, but never while an agent works in it', async () => {
    await call('POST', '/api/projects', { name: 'wiped', sourceControl: { kind: 'github' } });
    const busy = (await call('POST', '/api/cards', { title: 'Busy', repos: ['wiped'] })).body;
    await server.store.update(busy.id, { status: 'running' });
    const refused = await call('POST', '/api/projects/wiped/delete', { deleteFolder: true });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Stop the agents first: Busy/);
    assert.ok(existsSync(join(reposRoot, 'wiped')));

    await server.store.update(busy.id, { status: 'review' });
    const res = await call('POST', '/api/projects/wiped/delete', { deleteFolder: true });
    assert.equal(res.body.folderDeleted, true);
    assert.ok(!existsSync(join(reposRoot, 'wiped')));
    assert.ok(existsSync(bare('wiped')), 'the GitHub repository is never touched');
    assert.equal((await call('GET', '/api/repos')).body.includes('wiped'), false);
  });

  test('unknown projects are 404', async () => {
    assert.equal((await call('GET', '/api/projects/nope')).status, 404);
    assert.equal((await call('GET', '/api/projects/%E0%A4%A')).status, 404);
  });
});

describe('model and effort', () => {
  const flag = (inv, name) => (inv.args.includes(name) ? inv.args[inv.args.indexOf(name) + 1] : undefined);

  test('a new project has none chosen, and the planner then passes no flags', async () => {
    const res = await call('POST', '/api/projects', { name: 'untuned' });
    assert.equal(res.body.model, null);
    assert.equal(res.body.effort, null);
    await call('POST', '/api/projects/untuned/plan', { description: 'x' });
    await server.projects.settled();
    const inv = (await invocations()).at(-1);
    assert.equal(flag(inv, '--model'), undefined);
    assert.equal(flag(inv, '--effort'), undefined);
  });

  test('chosen at creation, they are stored and the planner uses them', async () => {
    const res = await call('POST', '/api/projects', { name: 'tuned', model: ' opus ', effort: 'high' });
    assert.equal(res.status, 201);
    assert.equal(res.body.model, 'opus');
    assert.equal(res.body.effort, 'high');
    assert.equal((await call('GET', '/api/projects')).body.find((p) => p.name === 'tuned').model, 'opus');
    await call('POST', '/api/projects/tuned/plan', { description: 'x' });
    await server.projects.settled();
    const inv = (await invocations()).at(-1);
    assert.equal(flag(inv, '--model'), 'opus');
    assert.equal(flag(inv, '--effort'), 'high');
  });

  test('blank values at creation mean the default', async () => {
    const res = await call('POST', '/api/projects', { name: 'blank-tuned', model: '', effort: '' });
    assert.equal(res.status, 201);
    assert.deepEqual([res.body.model, res.body.effort], [null, null]);
  });

  test('settings change one value at a time, and an empty value goes back to the default', async () => {
    await call('POST', '/api/projects', { name: 'knobs', model: 'sonnet', effort: 'low' });
    let res = await call('POST', '/api/projects/knobs/settings', { effort: 'max' });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.model, res.body.effort], ['sonnet', 'max'], 'the model was left alone');
    res = await call('POST', '/api/projects/knobs/settings', { model: 'claude-opus-5-5' });
    assert.deepEqual([res.body.model, res.body.effort], ['claude-opus-5-5', 'max'], 'a full model name is fine');
    res = await call('POST', '/api/projects/knobs/settings', { model: '', effort: null });
    assert.deepEqual([res.body.model, res.body.effort], [null, null]);
    assert.deepEqual((await call('GET', '/api/projects/knobs')).body.model, null, 'saved on disk');
  });

  test('bad values and unknown projects are refused', async () => {
    await call('POST', '/api/projects', { name: 'strict', model: 'sonnet' });
    for (const body of [{ model: '--help' }, { model: 'a b' }, { model: 'x'.repeat(200) }, { model: 5 }, { effort: 'extreme' }, { effort: 3 }, {}]) {
      assert.equal((await call('POST', '/api/projects/strict/settings', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call('POST', '/api/projects', { name: 'strict2', effort: 'extreme' })).status, 400);
    assert.ok(!existsSync(join(reposRoot, 'strict2')), 'nothing is created for a bad value');
    assert.equal((await call('GET', '/api/projects/strict')).body.model, 'sonnet', 'a refused change changes nothing');
    assert.equal((await call('POST', '/api/projects/nope/settings', { model: 'sonnet' })).status, 404);
  });

  test('cannot change while the planner runs, and the planner keeps the values it started with', async () => {
    await call('POST', '/api/projects', { name: 'busy-tuned', model: 'haiku' });
    await call('POST', '/api/projects/busy-tuned/plan', { description: 'SLOW' });
    const refused = await call('POST', '/api/projects/busy-tuned/settings', { model: 'opus' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /busy/);
    await server.projects.settled();
    assert.equal(flag((await invocations()).at(-1), '--model'), 'haiku');
    assert.equal((await call('GET', '/api/projects/busy-tuned')).body.model, 'haiku');
    assert.equal((await call('POST', '/api/projects/busy-tuned/settings', { model: 'opus' })).status, 200, 'allowed again once the plan is done');
  });

  test('a project made before the choice existed reads as default', async () => {
    await call('POST', '/api/projects', { name: 'old-timer' });
    const file = join(data, 'projects', 'old-timer', 'project.json');
    const p = JSON.parse(readFileSync(file, 'utf8'));
    delete p.model;
    delete p.effort;
    writeFileSync(file, JSON.stringify(p));
    const got = (await call('GET', '/api/projects/old-timer')).body;
    assert.deepEqual([got.model, got.effort], [null, null]);
    assert.deepEqual(await server.projects.settingsFor('old-timer'), { model: null, effort: null });
    assert.deepEqual(await server.projects.settingsFor('not-a-project'), { model: null, effort: null });
    assert.deepEqual(await server.projects.settingsFor(undefined), { model: null, effort: null });
  });

  test('the choices offered to the page are listed in /api/meta', async () => {
    const meta = (await call('GET', '/api/meta')).body;
    assert.deepEqual(meta.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.ok(meta.models.includes('opus') && meta.models.includes('sonnet'));
  });
});

describe('adding an existing folder', () => {
  const makeRepo = (name, { commit = true, remote = null } = {}) => {
    const path = join(dir, 'elsewhere', name);
    execFileSync('git', ['init', '-q', '-b', 'main', path]);
    if (commit) {
      writeFileSync(join(path, 'app.txt'), 'hello');
      sh(path, 'add', '.');
      sh(path, 'commit', '-qm', 'init');
    }
    if (remote) sh(path, 'remote', 'add', 'origin', remote);
    return path;
  };

  test('a repository outside the repos root becomes a project that cards can use, and its folder is left as it was', async () => {
    const path = makeRepo('Legacy App');
    const res = await call('POST', '/api/projects/existing', { path, name: 'legacy' });
    assert.equal(res.status, 201);
    assert.equal(res.body.step, 'existing');
    assert.equal(res.body.path, path);
    assert.equal(res.body.imported, true);
    assert.deepEqual(res.body.sourceControl, { kind: 'local' });
    assert.equal(sh(path, 'status', '--porcelain'), '', 'nothing was written to the folder');
    assert.ok((await call('GET', '/api/repos')).body.includes('legacy'));
    assert.equal((await call('POST', '/api/cards', { title: 'T', repos: ['legacy'] })).status, 201);
    assert.equal(server.repos.path('legacy'), path);
    assert.equal((await call('POST', '/api/projects/legacy/plan', { description: 'x' })).status, 400, 'planning is for new projects');
  });

  test('the name defaults to the folder name, and a GitHub origin is recognised without credentials', async () => {
    const path = makeRepo('from-gh', { remote: 'https://user:secret@github.com/acme/from-gh.git' });
    const res = await call('POST', '/api/projects/existing', { path });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'from-gh');
    assert.equal(res.body.sourceControl.fullName, 'acme/from-gh');
    assert.equal(res.body.sourceControl.pushed, true);
    assert.ok(!JSON.stringify(res.body).includes('secret'));
    const other = makeRepo('az', { remote: 'https://dev.azure.com/org/proj/_git/az' });
    const az = await call('POST', '/api/projects/existing', { path: other });
    assert.deepEqual(az.body.sourceControl, { kind: 'remote', url: 'https://dev.azure.com/org/proj/_git/az' });
  });

  test('a path that is not a usable repository root is refused', async () => {
    const plain = join(dir, 'elsewhere', 'plain');
    await mkdir(plain, { recursive: true });
    const sub = join(makeRepo('has-sub'), 'sub');
    await mkdir(sub, { recursive: true });
    const holder = join(dir, 'elsewhere', 'holder');
    await mkdir(join(holder, 'inner', '.git'), { recursive: true });
    for (const [path, why] of [
      ['', /full path/], ['relative/dir', /full path/], [join(dir, 'nowhere'), /not found/],
      [sub, /inside the git repository/], [holder, /holds one: inner/],
    ]) {
      const res = await call('POST', '/api/projects/existing', { path });
      assert.equal(res.status, 400, path);
      assert.match(res.body.error, why, path);
    }
  });

  test('a folder without a repository or commits is added only after the person agrees to create them', async () => {
    const plain = join(dir, 'elsewhere', 'plain2');
    await mkdir(plain, { recursive: true });
    writeFileSync(join(plain, 'a.txt'), 'hello');
    const ask = await call('POST', '/api/projects/existing', { path: plain });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.gitInit, true);
    assert.match(ask.body.error, /not a git repository/);
    const made = await call('POST', '/api/projects/existing', { path: plain, initGit: true });
    assert.equal(made.status, 201);
    assert.equal(sh(plain, 'show', '--name-only', '--format=', 'HEAD'), 'a.txt');

    const empty = makeRepo('empty', { commit: false });
    const askAgain = await call('POST', '/api/projects/existing', { path: empty });
    assert.equal(askAgain.status, 409);
    assert.match(askAgain.body.error, /without commits/);
    assert.equal((await call('POST', '/api/projects/existing', { path: empty, initGit: true })).status, 201);
  });

  test('a folder of repositories becomes one project whose planner reads all of them and whose tasks name their repos', async () => {
    const mono = join(dir, 'elsewhere', 'mono');
    const inner = ['web', 'backend'].map((n) => {
      const path = join(mono, n);
      execFileSync('git', ['init', '-q', '-b', 'main', path]);
      writeFileSync(join(path, 'app.txt'), n);
      sh(path, 'add', '.');
      sh(path, 'commit', '-qm', 'init');
      return path;
    });
    const ask = await call('POST', '/api/projects/existing', { paths: [mono] });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.workspace, true);
    const made = await call('POST', '/api/projects/existing', { paths: [mono], workspace: true });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.name, 'mono');
    assert.equal(made.body.step, 'existing', 'cards can be made right away; a plan is optional');
    assert.deepEqual(made.body.workspaceRepos.map((r) => r.name).sort(), ['backend', 'web']);

    assert.equal((await call('POST', '/api/projects/mono/plan', { description: 'Add a wishlist' })).status, 202);
    await server.projects.settled();
    const run = (await invocations()).at(-1);
    assert.match(run.prompt, /Repositories \(read[^\n]*\n- backend: [^\n]*\n- web: /);
    assert.equal(run.args[run.args.indexOf('--add-dir') + 1], made.body.workspaceRepos[1].path, 'the planner sees the other repositories');

    const res = await call('POST', '/api/projects/mono/tasks', { tasks: [0, 1] });
    assert.equal(res.status, 201);
    const [first, second] = await Promise.all(res.body.cards.map(async (id) => (await call('GET', `/api/cards/${id}`)).body));
    assert.deepEqual(first.repos, ['web'], 'unknown repo names are dropped');
    assert.deepEqual(second.repos.sort(), ['backend', 'web'], 'a task that names none works in all of them');
    for (const path of inner) assert.equal(sh(path, 'log', '--format=%s'), 'init', 'the repositories are untouched');
    assert.match(readFileSync(join(data, 'projects', 'mono', 'PLAN.md'), 'utf8'), /Suunnitelma/);

    assert.deepEqual(await server.projects.settingsFor('web'), { model: null, effort: null });
    assert.equal((await call('POST', '/api/projects/mono/settings', { model: 'opus', effort: 'high' })).status, 200);
    assert.deepEqual(await server.projects.settingsFor('web'), { model: 'opus', effort: 'high' }, 'the project over several repositories sets its repositories\' agents');
    assert.equal((await call('POST', '/api/projects/mono/delete', {})).status, 200);
    assert.ok(existsSync(inner[0]), 'the folders stay');
    const again = await call('POST', '/api/projects/existing', { paths: [inner[0]] });
    assert.equal(again.status, 201, 'a repository of a removed workspace can be added alone');
  });

  test('exploring writes a code map the project remembers, updates only what changed, and hands it to agents', async () => {
    const path = makeRepo('solo');
    assert.equal((await call('POST', '/api/projects/existing', { path })).status, 201);
    const before = (await call('GET', '/api/projects/solo/map')).body;
    assert.equal(before.state, 'none');
    assert.equal(before.stale, true);
    assert.equal(await server.explorer.contextFor('solo'), null, 'nothing to give agents before the first exploration');

    assert.equal((await call('POST', '/api/projects/solo/explore', {})).status, 202);
    assert.equal((await call('POST', '/api/projects/solo/explore', {})).status, 400, 'one exploration at a time');
    await server.explorer.settled();
    let map = (await call('GET', '/api/projects/solo/map')).body;
    assert.equal(map.state, 'ready', map.error);
    assert.equal(map.stale, false);
    assert.equal(map.repos[0].behind, 0);
    assert.match(map.text, /Overview v1 of solo/);
    assert.match(map.text, /core\.md: Core/);
    assert.equal(readFileSync(join(map.dir, 'areas', 'solo--core.md'), 'utf8'), 'Core notes\n');

    const context = await server.explorer.contextFor('solo');
    assert.match(context.section, /Code map of this project[\s\S]*Overview v1 of solo/);
    assert.deepEqual(context.dirs, [join(map.dir, 'areas')]);

    writeFileSync(join(path, 'orders.txt'), 'new');
    sh(path, 'add', '.');
    sh(path, 'commit', '-qm', 'orders');
    map = (await call('GET', '/api/projects/solo/map')).body;
    assert.equal(map.repos[0].behind, 1);
    assert.equal(map.stale, true);
    await call('POST', '/api/projects/solo/explore', {});
    await server.explorer.settled();
    const update = (await invocations()).at(-1);
    assert.match(update.prompt, /## Previous overview\n\nOverview v1 of solo/);
    assert.match(update.prompt, /orders\.txt/, 'the model is told which files changed');
    map = (await call('GET', '/api/projects/solo/map')).body;
    assert.match(map.text, /Overview v2 of solo/);
    assert.equal(readFileSync(join(map.dir, 'areas', 'solo--api.md'), 'utf8'), 'API notes v2\n', 'a changed area is replaced');
    assert.equal(readFileSync(join(map.dir, 'areas', 'solo--core.md'), 'utf8'), 'Core notes\n', 'an untouched area is kept');
    assert.equal(map.stale, false);

    const count = (await invocations()).length;
    await call('POST', '/api/projects/solo/explore', {});
    await server.explorer.settled();
    assert.equal((await invocations()).length, count, 'nothing moved: nothing is studied');
    assert.equal((await call('GET', '/api/projects/solo/map')).body.state, 'ready');

    const card = (await call('POST', '/api/cards', { title: 'Add a thing', brief: 'x', repos: ['solo'] })).body;
    await call('POST', `/api/cards/${card.id}/refine/start`, {});
    let refine;
    for (let i = 0; i < 50 && !refine; i++) {
      refine = (await invocations()).find((x) => x.prompt.includes('Add a thing') && x.args.includes('--add-dir'));
      if (!refine) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(refine, 'the refiner started');
    assert.match(refine.args[refine.args.indexOf('--append-system-prompt') + 1], /Code map of this project[\s\S]*Overview v2 of solo/);
    assert.ok(refine.args.includes(join(map.dir, 'areas')), 'the refiner may read the area notes');
  });

  test('the vulnerability audit runs by itself at the chosen interval, read-only, and reports findings worst first', async () => {
    const path = makeRepo('audited');
    assert.equal((await call('POST', '/api/projects/existing', { path })).status, 201);
    const fresh = (await call('GET', '/api/projects/audited/audit')).body;
    assert.deepEqual([fresh.enabled, fresh.everyMin, fresh.state, fresh.findings], [false, 1440, 'none', []]);

    for (const bad of [{}, { enabled: 'yes' }, { everyMin: 2 }, { everyMin: 1.5 }, { everyMin: '60' }, { everyMin: 999999 }]) {
      assert.equal((await call('POST', '/api/projects/audited/audit', bad)).status, 400, JSON.stringify(bad));
    }
    const before = (await invocations()).length;
    await server.auditor.tick();
    await server.auditor.settled();
    assert.equal((await invocations()).length, before, 'switched off: nothing is audited');

    const on = await call('POST', '/api/projects/audited/audit', { enabled: true, everyMin: 30 });
    assert.deepEqual([on.status, on.body.enabled, on.body.everyMin], [200, true, 30]);
    assert.deepEqual((await call('GET', '/api/projects/audited')).body.audit, { enabled: true, everyMin: 30 });

    await server.auditor.tick();
    await server.auditor.settled();
    const run = (await invocations()).at(-1);
    assert.equal(run.cwd.toLowerCase(), path.toLowerCase());
    assert.ok(run.args.includes('Bash(npm audit:*)'), 'it may ask the registry about known vulnerabilities');
    assert.ok(run.args.slice(run.args.indexOf('--disallowedTools')).includes('Edit'), 'and may not change anything');
    let audit = (await call('GET', '/api/projects/audited/audit')).body;
    assert.equal(audit.state, 'ready', audit.error);
    assert.deepEqual(audit.findings.map((f) => [f.severity, f.title]), [['high', 'SQL injection'], ['low', 'Debug flag on']], 'worst first, the untitled one dropped');
    assert.deepEqual([audit.counts.high, audit.counts.low, audit.counts.critical], [1, 1, 0]);
    assert.ok(audit.nextAt, 'the next audit is scheduled');

    // A finding becomes a card in the inbox, once.
    const sqli = audit.findings[0];
    assert.equal(sqli.card, null);
    assert.equal((await call('POST', '/api/projects/audited/audit/ticket', { finding: 'nope' })).status, 400);
    const made = await call('POST', '/api/projects/audited/audit/ticket', { finding: sqli.id });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const cardRef = made.body.findings.find((f) => f.id === sqli.id).card;
    assert.equal(cardRef.status, 'inbox');
    const card = (await call('GET', `/api/cards/${cardRef.id}`)).body;
    assert.deepEqual([card.title, card.priority, card.repos], ['Tietoturva: SQL injection', 'high', ['audited']]);
    assert.match(card.brief, /solo: app\.txt:3[\s\S]*query built from input[\s\S]*use parameters/);
    assert.equal((await call('POST', '/api/projects/audited/audit/ticket', { finding: sqli.id })).status, 400, 'one card per finding');
    assert.equal(made.body.findings.find((f) => f.id !== sqli.id).card, null);

    const count = (await invocations()).length;
    await server.auditor.tick();
    await server.auditor.settled();
    assert.equal((await invocations()).length, count, 'not due yet');

    const file = join(data, 'projects', 'audited', 'audit', 'audit.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...saved, startedAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
    await server.auditor.tick();
    await server.auditor.settled();
    assert.equal((await invocations()).length, count + 1, 'the interval has passed');

    assert.equal((await call('POST', '/api/projects/audited/audit', { enabled: false })).body.enabled, false);
    writeFileSync(file, JSON.stringify({ ...saved, startedAt: new Date(Date.now() - 99 * 60_000).toISOString() }));
    await server.auditor.tick();
    await server.auditor.settled();
    assert.equal((await invocations()).length, count + 1, 'switched off again');

    // By hand even when switched off, one at a time.
    const slow = makeRepo('SLOW-audit');
    await call('POST', '/api/projects/existing', { path: slow });
    assert.equal((await call('POST', '/api/projects/SLOW-audit/audit/run', {})).status, 202);
    assert.equal((await call('POST', '/api/projects/SLOW-audit/audit/run', {})).status, 400, 'one audit at a time');
    assert.equal((await call('GET', '/api/projects/SLOW-audit/audit')).body.state, 'running');
    await server.auditor.settled();
    audit = (await call('GET', '/api/projects/SLOW-audit/audit')).body;
    assert.equal(audit.state, 'ready', audit.error);
    assert.equal(audit.findings.length, 2);
  });

  test('each repository\'s branch is told against the base branch and its upstream, and the remote is fetched only when asked', async () => {
    const origin = join(dir, 'elsewhere', 'branchy-origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    const path = makeRepo('branchy', { remote: origin });
    sh(path, 'push', '-q', '-u', 'origin', 'main');
    assert.equal((await call('POST', '/api/projects/existing', { path })).status, 201);
    const status = async (q = '') => (await call('GET', `/api/projects/branchy/branches${q}`)).body[0];
    const pick = (r) => [r.branch, r.base, r.ahead, r.behind, r.upstream, r.toPush, r.toPull, r.changed];

    assert.deepEqual(pick(await status()), ['main', 'origin/main', 0, 0, 'origin/main', 0, 0, 0]);

    sh(path, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(path, 'f.txt'), 'x');
    sh(path, 'add', '.');
    sh(path, 'commit', '-qm', 'feature work');
    writeFileSync(join(path, 'dirty.txt'), 'y');
    assert.deepEqual(pick(await status()), ['feature', 'origin/main', 1, 0, null, null, null, 1], 'one commit not in main, no upstream, one uncommitted file');

    // Someone else adds to main on the remote: seen only after a fetch.
    const other = join(dir, 'elsewhere', 'branchy-other');
    execFileSync('git', ['clone', '-q', '-b', 'main', origin, other]);
    writeFileSync(join(other, 'g.txt'), 'z');
    sh(other, 'add', '.');
    sh(other, 'commit', '-qm', 'elsewhere');
    sh(other, 'push', '-q', 'origin', 'main');
    assert.equal((await status()).behind, 0, 'nothing is fetched by default');
    assert.equal((await status('?fetch=1')).behind, 1);

    const commits = (await call('GET', '/api/projects/branchy/commits')).body[0];
    assert.deepEqual([commits.branch, commits.ahead, commits.commits[0].subject], ['feature', 1, 'feature work'], 'the commits carry the branch status too');

    // Switching: refused with uncommitted changes or an unknown branch; back to main, it is brought up to origin.
    assert.deepEqual((await status()).switchable, ['feature', 'main']);
    const sw = (body) => call('POST', '/api/projects/branchy/branches', body);
    assert.equal((await sw({ repo: 'branchy', branch: 'main' })).status, 400, 'uncommitted changes');
    rmSync(join(path, 'dirty.txt'));
    for (const bad of [{ repo: 'nope', branch: 'main' }, { repo: 'branchy', branch: 'no-such' }, { repo: 'branchy', branch: '--orphan' }, { repo: 'branchy' }]) {
      assert.equal((await sw(bad)).status, 400, JSON.stringify(bad));
    }
    const back = await sw({ repo: 'branchy', branch: 'main' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(pick(back.body[0]), ['main', 'origin/main', 0, 0, 'origin/main', 0, 0, 0], 'on main and pulled up to origin/main');
    assert.equal(sh(path, 'log', '-1', '--format=%s'), 'elsewhere');

    // A branch only on the remote becomes a local branch that tracks it; one a worktree holds cannot be chosen.
    sh(other, 'push', '-q', 'origin', 'main:remote-only');
    sh(path, 'worktree', 'add', '-q', join(dir, 'elsewhere', 'branchy-wt'), 'feature');
    assert.deepEqual((await status('?fetch=1')).switchable, ['main', 'remote-only']);
    assert.equal((await sw({ repo: 'branchy', branch: 'feature' })).status, 400, 'checked out in a worktree');
    const remote = (await sw({ repo: 'branchy', branch: 'remote-only' })).body[0];
    assert.deepEqual([remote.branch, remote.upstream], ['remote-only', 'origin/remote-only']);
  });

  test('a hidden project\'s cards are marked and left out of "your turn", and a repository a shown project also has keeps its cards shown', async () => {
    const path = makeRepo('shy');
    assert.equal((await call('POST', '/api/projects/existing', { path })).status, 201);
    const own = (await call('POST', '/api/cards', { title: 'Shy work', repos: ['shy'] })).body;
    const mixed = (await call('POST', '/api/cards', { title: 'Shared work', repos: ['shy', 'nobody-hides-this'] })).body;
    const isHidden = async (id) => (await call('GET', '/api/cards')).body.find((c) => c.id === id).hidden === true;
    const startable = async () => (await call('GET', '/api/next')).body.yourTurn.find((x) => x.what === 'Inbox')?.title ?? '';
    assert.equal(await isHidden(own.id), false);
    const before = await startable();
    for (const bad of [{}, { hidden: 'yes' }]) assert.equal((await call('POST', '/api/projects/shy/hidden', bad)).status, 400);

    const hid = await call('POST', '/api/projects/shy/hidden', { hidden: true });
    assert.deepEqual([hid.status, hid.body.hidden], [200, true]);
    assert.equal((await call('GET', '/api/projects')).body.find((p) => p.name === 'shy').hidden, true, 'still in the project list, marked');
    assert.equal(await isHidden(own.id), true);
    assert.equal(await isHidden(mixed.id), false, 'it also works in a repository of no hidden project');
    const after = await startable();
    assert.notEqual(after, before, 'the inbox entry no longer counts it');
    assert.equal((await call('GET', '/api/next')).body.yourTurn.some((x) => x.card === own.id), false);
    assert.equal((await call('GET', `/api/cards/${own.id}`)).status, 200, 'the card itself still opens');

    assert.equal((await call('POST', '/api/projects/shy/hidden', { hidden: false })).body.hidden, false);
    assert.equal(await isHidden(own.id), false);
    for (const c of [own, mixed]) await call('PATCH', `/api/cards/${c.id}`, { status: 'archive' });
  });

  test('a project over several repositories gets a map of how they connect, and only a new project is refused', async () => {
    const ws = join(dir, 'elsewhere', 'duo');
    for (const n of ['front', 'back']) {
      const path = join(ws, n);
      execFileSync('git', ['init', '-q', '-b', 'main', path]);
      writeFileSync(join(path, 'app.txt'), n);
      sh(path, 'add', '.');
      sh(path, 'commit', '-qm', 'init');
    }
    assert.equal((await call('POST', '/api/projects/existing', { paths: [ws], workspace: true })).status, 201);
    await call('POST', '/api/projects/duo/explore', {});
    await server.explorer.settled();
    const map = (await call('GET', '/api/projects/duo/map')).body;
    assert.equal(map.state, 'ready', map.error);
    assert.match(map.text, /Overview v1 of back[\s\S]*Overview v1 of front/);
    assert.match(map.text, /## How the repositories connect\n\nweb calls the backend orders API/);
    const contracts = (await invocations()).find((x) => x.prompt.includes('has 2 repositories'));
    assert.equal(contracts.args.filter((a) => a === '--add-dir').length, 1, 'the contracts agent reads the other repository too');
    const context = await server.explorer.contextFor('front');
    assert.match(context.section, /How the repositories connect/, 'a repository of the project gets the whole map');

    await call('POST', '/api/projects', { name: 'fresh' });
    assert.equal((await call('POST', '/api/projects/fresh/explore', {})).status, 400);
  });

  test('the same folder or name cannot be added twice, and a name used by a repo under the root is refused', async () => {
    const path = makeRepo('dupe');
    assert.equal((await call('POST', '/api/projects/existing', { path })).status, 201);
    const again = await call('POST', '/api/projects/existing', { path, name: 'dupe-2' });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already the project dupe/);
    assert.equal((await call('POST', '/api/projects/existing', { path: makeRepo('dupe-b'), name: 'dupe' })).status, 400);
    await mkdir(join(reposRoot, 'rooted', '.git'), { recursive: true });
    const clash = await call('POST', '/api/projects/existing', { path: makeRepo('clash'), name: 'rooted' });
    assert.equal(clash.status, 400);
    assert.match(clash.body.error, /another repository/);
  });

  test('removing it never deletes the folder, and the name stops resolving to it', async () => {
    const path = makeRepo('keeper');
    await call('POST', '/api/projects/existing', { path });
    const refused = await call('POST', '/api/projects/keeper/delete', { deleteFolder: true });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /does not delete/);
    assert.ok(existsSync(join(path, '.git')));
    assert.equal((await call('POST', '/api/projects/keeper/delete', {})).status, 200);
    assert.ok(existsSync(join(path, 'app.txt')), 'the folder stays');
    assert.equal((await call('GET', '/api/repos')).body.includes('keeper'), false);
    assert.equal(server.repos.path('keeper'), join(reposRoot, 'keeper'));
  });
});

describe('GitHub token', () => {
  test('comes from the environment, then gh, then Git Credential Manager', async () => {
    const calls = [];
    const run = (answers) => async (cmd, args, input) => {
      calls.push([cmd, ...args]);
      const a = answers[cmd];
      if (a instanceof Error) throw a;
      return a;
    };
    assert.equal(await createGithubToken({ env: { AGENTCONTROL_GITHUB_TOKEN: ' env-tok ' }, run: run({}) })(), 'env-tok');
    assert.equal(calls.length, 0);
    assert.equal(await createGithubToken({ env: {}, run: run({ gh: 'gh-tok\n' }) })(), 'gh-tok');
    assert.equal(await createGithubToken({ env: {}, run: run({ gh: new Error('no gh'), git: 'protocol=https\nhost=github.com\nusername=me\npassword=gcm-tok\n' }) })(), 'gcm-tok');
    await assert.rejects(createGithubToken({ env: {}, run: run({ gh: new Error('no gh'), git: new Error('nothing') }) })(), /No GitHub login found/);
  });
});

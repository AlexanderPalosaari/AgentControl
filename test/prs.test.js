import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createAzCliToken, createAzdo, parseRemote } from '../lib/azdo.js';
import { createWorktree } from '../lib/git.js';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const token = 't';
const headers = { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' };

describe('parseRemote', () => {
  const want = { baseUrl: 'https://dev.azure.com/acme', project: 'My Project', repo: 'api' };
  test('understands the Azure DevOps remote URL forms', () => {
    assert.deepEqual(parseRemote('https://dev.azure.com/acme/My%20Project/_git/api'), want);
    assert.deepEqual(parseRemote('https://acme@dev.azure.com/acme/My%20Project/_git/api'), want);
    assert.deepEqual(parseRemote('git@ssh.dev.azure.com:v3/acme/My Project/api'), want);
    assert.deepEqual(parseRemote('ssh://git@ssh.dev.azure.com:22/v3/acme/My%20Project/api'), want);
    assert.deepEqual(parseRemote('https://acme.visualstudio.com/DefaultCollection/My%20Project/_git/api'),
      { baseUrl: 'https://acme.visualstudio.com', project: 'My Project', repo: 'api' });
  });
  test('rejects other hosts', () => {
    assert.equal(parseRemote('https://github.com/acme/api.git'), null);
    assert.equal(parseRemote('C:\\repos\\origin.git'), null);
    assert.equal(parseRemote('https://evil.example/dev.azure.com/acme/p/_git/r'), null);
  });
});

describe('az token', () => {
  test('is cached until shortly before it expires', async () => {
    let calls = 0;
    const far = new Date(Date.now() + 3600_000).toISOString();
    const getToken = createAzCliToken({ run: async () => { calls++; return JSON.stringify({ accessToken: `tok${calls}`, expiresOn: far }); } });
    assert.equal(await getToken(), 'tok1');
    assert.equal(await getToken(), 'tok1');
    assert.equal(calls, 1);
    const soon = new Date(Date.now() + 60_000).toISOString();
    const refreshing = createAzCliToken({ run: async () => { calls++; return JSON.stringify({ accessToken: `tok${calls}`, expiresOn: soon }); } });
    await refreshing();
    await refreshing();
    assert.equal(calls, 3, 'a token about to expire is fetched again');
  });
});

describe('publishing', () => {
  let dir, data, reposRoot, azServer, azBase, prsOnServer, requests, server, base, publisher, nextId = 100, cardCount = 0;

  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const getCard = async (id) => (await call('GET', `/api/cards/${id}`)).body;

  /** A card in review with a real worktree that has one commit, as a finished run would leave it. */
  async function reviewCard(target = null) {
    const card = (await call('POST', '/api/cards', { title: `Add login ${++cardCount}`, repos: ['demo'], baseBranch: target })).body;
    const repoPath = join(reposRoot, 'demo');
    const wt = await createWorktree({ repoPath, path: join(data, 'worktrees', card.id, 'demo'), branch: `ac/${card.id}-add-login`, target });
    writeFileSync(join(wt.path, 'login.js'), 'export const login = () => true;\n');
    sh(wt.path, 'add', '.');
    sh(wt.path, 'commit', '-qm', 'Add login');
    const cardDir = join(data, 'cards', card.id);
    writeFileSync(join(cardDir, 'run.json'), JSON.stringify({ state: 'finished', agentId: 'abc', worktrees: [{ repo: 'demo', ...wt }], replies: 0 }));
    writeFileSync(join(cardDir, 'commit-message.txt'), 'Add login endpoint\n\nDetails here.');
    writeFileSync(join(cardDir, 'report.md'), '# Report\nAll good.');
    await server.store.update(card.id, { status: 'review' });
    return { card, wt, cardDir };
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcontrol-prs-'));
    data = join(dir, 'data');
    reposRoot = join(dir, 'repos');
    await mkdir(reposRoot, { recursive: true });
    Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
    sh(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    sh(reposRoot, 'clone', '-q', join(dir, 'origin.git'), 'demo');
    writeFileSync(join(reposRoot, 'demo', 'a.txt'), 'v1\n');
    sh(join(reposRoot, 'demo'), 'add', '.');
    sh(join(reposRoot, 'demo'), 'commit', '-qm', 'init');
    sh(join(reposRoot, 'demo'), 'push', '-q', 'origin', 'HEAD:main');
    sh(join(reposRoot, 'demo'), 'fetch', '-q', 'origin');
    sh(join(reposRoot, 'demo'), 'remote', 'set-head', 'origin', 'main');

    // A tiny stand-in for the Azure DevOps pull request API.
    prsOnServer = new Map();
    requests = [];
    azServer = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://x');
        requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, apiVersion: url.searchParams.get('api-version'), body: body ? JSON.parse(body) : null });
        const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
        if (azServer.reject) return send(401, { message: 'TF400813: not authorized' });
        const m = url.pathname.match(/^\/P\/_apis\/git\/repositories\/R\/pullrequests(?:\/(\d+))?$/);
        if (!m) return send(404, { message: 'no route' });
        if (req.method === 'POST') {
          const b = JSON.parse(body);
          const pr = { pullRequestId: ++nextId, status: 'active', mergeStatus: 'succeeded', sourceRefName: b.sourceRefName, targetRefName: b.targetRefName, title: b.title, description: b.description };
          prsOnServer.set(pr.pullRequestId, pr);
          return send(201, pr);
        }
        if (m[1]) return prsOnServer.has(+m[1]) ? send(200, prsOnServer.get(+m[1])) : send(404, { message: 'gone' });
        const src = url.searchParams.get('searchCriteria.sourceRefName');
        return send(200, { value: [...prsOnServer.values()].filter((p) => p.sourceRefName === src && p.status === 'active') });
      });
    });
    await new Promise((r) => azServer.listen(0, '127.0.0.1', r));
    azBase = `http://127.0.0.1:${azServer.address().port}`;

    server = createApp({
      dataDir: data, token, reposRoot,
      azdo: createAzdo({ getToken: async () => 'secret-token' }),
      publisher: { resolveRemote: async () => ({ baseUrl: azBase, project: 'P', repo: 'R' }), pollMs: 0 },
    });
    publisher = server.publisher;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => azServer.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => { azServer.reject = false; requests.length = 0; });

  test('pushes the branch and opens a pull request with the commit message and report', async () => {
    const { card, wt } = await reviewCard();
    const res = await call('POST', `/api/cards/${card.id}/pr`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    const pr = res.body[0];
    assert.equal(pr.state, 'active');
    assert.equal(pr.url, `${azBase}/P/_git/R/pullrequest/${pr.id}`);
    assert.equal(pr.target, 'main');

    assert.match(sh(join(dir, 'origin.git'), 'branch', '--list', wt.branch), new RegExp(wt.branch), 'the branch reached origin');
    const post = requests.find((r) => r.method === 'POST');
    assert.equal(post.auth, 'Bearer secret-token');
    assert.equal(post.apiVersion, '7.1');
    assert.equal(post.body.title, 'Add login endpoint');
    assert.equal(post.body.sourceRefName, `refs/heads/${wt.branch}`);
    assert.equal(post.body.targetRefName, 'refs/heads/main');
    assert.match(post.body.description, /Details here\./);
    assert.match(post.body.description, /## Agent report\n\n# Report\nAll good\./);

    const run = (await call('GET', `/api/cards/${card.id}/run`)).body;
    assert.equal(run.prs[0].id, pr.id);
  });

  test('publishing again does not create a second pull request', async () => {
    const { card } = await reviewCard();
    await call('POST', `/api/cards/${card.id}/pr`);
    requests.length = 0;
    const again = await call('POST', `/api/cards/${card.id}/pr`);
    assert.equal(again.body.length, 1);
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
  });

  test('an already open pull request for the branch is reused', async () => {
    const { card, cardDir } = await reviewCard();
    const first = (await call('POST', `/api/cards/${card.id}/pr`)).body[0];
    rmSync(join(cardDir, 'prs.json'));
    requests.length = 0;
    const res = await call('POST', `/api/cards/${card.id}/pr`);
    assert.equal(res.body[0].id, first.id);
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
  });

  test('only cards in review can be published', async () => {
    const card = (await call('POST', '/api/cards', { title: 'x', repos: ['demo'] })).body;
    const res = await call('POST', `/api/cards/${card.id}/pr`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /in review/);
  });

  test('an Azure DevOps error is reported and nothing is recorded', async () => {
    const { card, cardDir } = await reviewCard();
    azServer.reject = true;
    const res = await call('POST', `/api/cards/${card.id}/pr`);
    assert.equal(res.status, 502);
    assert.match(res.body.error, /TF400813/);
    assert.ok(!existsSync(join(cardDir, 'prs.json')));
    assert.equal((await getCard(card.id)).status, 'review');
  });

  test('a completed pull request finishes the card and removes its worktree and branch', async () => {
    const { card, wt } = await reviewCard();
    const pr = (await call('POST', `/api/cards/${card.id}/pr`)).body[0];
    await publisher.poll({ force: true });
    assert.equal((await getCard(card.id)).status, 'review', 'still active');

    prsOnServer.get(pr.id).status = 'completed';
    await publisher.poll({ force: true });
    assert.equal((await getCard(card.id)).status, 'done');
    assert.ok(!existsSync(wt.path), 'worktree removed');
    assert.equal(sh(join(reposRoot, 'demo'), 'branch', '--list', wt.branch), '', 'local branch removed');
    assert.equal(JSON.parse(readFileSync(join(data, 'cards', card.id, 'prs.json'), 'utf8'))[0].state, 'completed');
  });

  test('the pull request goes into the card\'s base branch, and the card view shows where before anything is pushed', async () => {
    const repoPath = join(reposRoot, 'demo');
    sh(repoPath, 'push', '-q', 'origin', 'origin/main:refs/heads/features/dev');
    sh(repoPath, 'fetch', '-q', 'origin');
    const { card, wt } = await reviewCard('features/dev');
    assert.equal(wt.base, 'origin/features/dev');
    const [before] = (await call('GET', `/api/cards/${card.id}/run`)).body.publish;
    assert.deepEqual([before.branch, before.target, before.commits, before.problems, before.toPush], [wt.branch, 'features/dev', 1, [], null]);

    const [pr] = (await call('POST', `/api/cards/${card.id}/pr`)).body;
    assert.equal(pr.target, 'features/dev');
    assert.equal(requests.find((r) => r.method === 'POST').body.targetRefName, 'refs/heads/features/dev');
  });

  test('a branch that was not made from its target is published only once the person confirms', async () => {
    const repoPath = join(reposRoot, 'demo');
    // origin's main moves on, so a branch made from it carries a commit features/dev does not have.
    const other = join(dir, 'other-main');
    sh(dir, 'clone', '-q', join(dir, 'origin.git'), 'other-main');
    writeFileSync(join(other, 'main-only.txt'), 'm\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-qm', 'main only');
    sh(other, 'push', '-q', 'origin', 'HEAD:main');
    sh(repoPath, 'fetch', '-q', 'origin');
    const { card, cardDir } = await reviewCard();
    const run = JSON.parse(readFileSync(join(cardDir, 'run.json'), 'utf8'));
    run.worktrees[0].base = 'origin/features/dev'; // as if the work had been moved onto main by hand
    writeFileSync(join(cardDir, 'run.json'), JSON.stringify(run));

    const shown = (await call('GET', `/api/cards/${card.id}/run`)).body.publish[0];
    assert.equal(shown.problems.length, 1);
    assert.match(shown.problems[0], /is not in features\/dev/);
    const refused = await call('POST', `/api/cards/${card.id}/pr`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.confirm, true);
    assert.match(refused.body.problems[0], /^demo: /);
    assert.equal(sh(join(dir, 'origin.git'), 'branch', '--list', run.worktrees[0].branch), '', 'nothing was pushed');
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);

    const confirmed = await call('POST', `/api/cards/${card.id}/pr`, { confirmed: true });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body[0].target, 'features/dev');
  });

  test('commits made after the pull request was opened are pushed to it on request', async () => {
    const { card, wt } = await reviewCard();
    const [pr] = (await call('POST', `/api/cards/${card.id}/pr`)).body;
    assert.equal((await call('POST', `/api/cards/${card.id}/pr/update`)).body.pushed.length, 0, 'nothing new yet');

    writeFileSync(join(wt.path, 'login.js'), 'export const login = () => false;\n');
    sh(wt.path, 'commit', '-qam', 'Fix after review');
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.publish[0].toPush, 1);
    const res = await call('POST', `/api/cards/${card.id}/pr/update`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pushed, [{ repo: 'demo', branch: wt.branch, commits: 1 }]);
    assert.equal(sh(join(dir, 'origin.git'), 'rev-parse', wt.branch), sh(wt.path, 'rev-parse', 'HEAD'));
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.publish[0].toPush, 0);
    assert.equal(requests.filter((r) => r.method === 'POST').length, 1, 'the same pull request, no new one');

    sh(wt.path, 'commit', '-q', '--amend', '-m', 'Rewritten');
    const rewritten = await call('POST', `/api/cards/${card.id}/pr/update`);
    assert.equal(rewritten.status, 400);
    assert.match(rewritten.body.error, /refused the push/);

    prsOnServer.get(pr.id).mergeStatus = 'conflicts';
    await publisher.poll({ force: true });
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.prs[0].mergeStatus, 'conflicts', 'kept for the card view');
  });

  test('an abandoned pull request keeps the card in review and its worktree', async () => {
    const { card, wt } = await reviewCard();
    const pr = (await call('POST', `/api/cards/${card.id}/pr`)).body[0];
    prsOnServer.get(pr.id).status = 'abandoned';
    await publisher.poll({ force: true });
    assert.equal((await getCard(card.id)).status, 'review');
    assert.ok(existsSync(wt.path));
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.prs[0].state, 'abandoned');
  });
});

describe('origin that is not Azure DevOps', () => {
  test('is refused with a clear message, before anything is pushed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentcontrol-prs2-'));
    try {
      const reposRoot = join(dir, 'repos');
      await mkdir(reposRoot, { recursive: true });
      Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
      sh(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
      sh(reposRoot, 'clone', '-q', join(dir, 'origin.git'), 'demo');
      writeFileSync(join(reposRoot, 'demo', 'a.txt'), 'v1\n');
      sh(join(reposRoot, 'demo'), 'add', '.');
      sh(join(reposRoot, 'demo'), 'commit', '-qm', 'init');
      sh(join(reposRoot, 'demo'), 'push', '-q', 'origin', 'HEAD:main');
      const app = createApp({ dataDir: join(dir, 'data'), token, reposRoot, azdo: createAzdo({ getToken: async () => 'x' }) });
      await new Promise((r) => app.listen(0, '127.0.0.1', r));
      const b = `http://127.0.0.1:${app.address().port}`;
      const c = await (await fetch(`${b}/api/cards`, { method: 'POST', headers, body: JSON.stringify({ title: 't', repos: ['demo'] }) })).json();
      const wt = await createWorktree({ repoPath: join(reposRoot, 'demo'), path: join(dir, 'data', 'worktrees', c.id, 'demo'), branch: `ac/${c.id}-t` });
      writeFileSync(join(dir, 'data', 'cards', c.id, 'run.json'), JSON.stringify({ state: 'finished', worktrees: [{ repo: 'demo', ...wt }] }));
      await app.store.update(c.id, { status: 'review' });
      const res = await fetch(`${b}/api/cards/${c.id}/pr`, { method: 'POST', headers });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /not an Azure DevOps repository/);
      assert.equal(sh(join(dir, 'origin.git'), 'branch', '--list', wt.branch), '', 'nothing was pushed');
      await new Promise((r) => app.close(r));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

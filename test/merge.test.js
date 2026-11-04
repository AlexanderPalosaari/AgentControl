import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createWorktree } from '../lib/git.js';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const headers = { Cookie: 'ac_token=t', 'Content-Type': 'application/json' };
let dir, data, reposRoot, server, base, seq = 0;

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

/** A review card whose agent branch added `file` in repo `repo` (by default one with no remote, like a local project). */
async function reviewCard(file = 'app.js', repo = 'local') {
  const card = (await call('POST', '/api/cards', { title: `Lisää ${file}`, repos: [repo] })).body;
  const wt = await createWorktree({ repoPath: join(reposRoot, repo), path: join(data, 'worktrees', card.id, repo), branch: `ac/${card.id}-x` });
  seq++;
  writeFileSync(join(wt.path, file), `export const v = ${seq};\n`);
  sh(wt.path, 'add', '.');
  sh(wt.path, 'commit', '-qm', 'agent wip 1');
  writeFileSync(join(wt.path, file), `export const v = ${seq};\n// done\n`);
  sh(wt.path, 'commit', '-qam', 'agent wip 2');
  const cardDir = join(data, 'cards', card.id);
  writeFileSync(join(cardDir, 'run.json'), JSON.stringify({ state: 'finished', agentId: 'abc', worktrees: [{ repo, ...wt }], replies: 0 }));
  writeFileSync(join(cardDir, 'commit-message.txt'), `Add ${file}\n\nBody line.`);
  writeFileSync(join(cardDir, 'report.md'), '# Report\nthis must not end up in the commit');
  await server.store.update(card.id, { status: 'review' });
  return { card, wt, v: seq };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-merge-'));
  data = join(dir, 'data');
  reposRoot = join(dir, 'repos');
  await mkdir(reposRoot, { recursive: true });
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', // a test must never be able to open a credential prompt
  });
  const repo = join(reposRoot, 'local');
  await mkdir(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# local\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'Initial commit');

  server = createApp({ dataDir: data, token: 't', reposRoot });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe('accepting work into a local repository', () => {
  test('squashes the branch into main as one commit, finishes the card, cleans up and unblocks dependents', async () => {
    const { card, wt, v } = await reviewCard('app.js');
    const dependent = (await call('POST', '/api/cards', { title: 'Odottaja', repos: ['local'], after: card.id })).body;
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.localMerge, true, 'the page may show the button');
    const repo = join(reposRoot, 'local');
    const before = sh(repo, 'rev-parse', 'HEAD');

    const res = await call('POST', `/api/cards/${card.id}/merge`);
    assert.equal(res.status, 200);
    assert.equal(res.body[0].repo, 'local');
    assert.equal(sh(repo, 'log', '--format=%B', '-1').trim(), 'Add app.js\n\nBody line.', 'the agent\'s message, without the report');
    assert.equal(sh(repo, 'rev-list', '--count', `${before}..main`), '1', 'one commit for two agent commits');
    assert.equal(readFileSync(join(repo, 'app.js'), 'utf8').replace(/\r\n/g, '\n'), `export const v = ${v};\n// done\n`, 'line endings may be CRLF on Windows');
    assert.equal(sh(repo, 'status', '--porcelain'), '');
    assert.equal(sh(repo, 'rev-parse', `refs/agentcontrol/premerge/${card.id}`), before, 'the old tip is kept for an undo');
    assert.equal(sh(repo, 'branch', '--list', wt.branch), '', 'the agent branch is gone');
    assert.ok(!existsSync(wt.path), 'the worktree is gone');
    assert.equal((await call('GET', `/api/cards/${card.id}`)).body.status, 'done');
    assert.ok((await call('GET', '/api/events')).body.some((e) => e.kind === 'merge' && e.card === card.id));

    const next = (await call('GET', '/api/next')).body;
    assert.ok(next.yourTurn.some((x) => x.what === 'Inbox' && x.detail.includes('Odottaja')), 'the dependent card can be started now');
    assert.equal((await call('POST', `/api/cards/${card.id}/merge`)).status, 400, 'only once');
    await server.store.update(dependent.id, { status: 'archive' });
  });

  test('the to-do list tells a local repo to accept the work, and names who waits for it', async () => {
    const { card } = await reviewCard('list.js');
    const waiting = (await call('POST', '/api/cards', { title: 'Odottaa listaa', repos: ['local'], after: card.id })).body;
    const next = (await call('GET', '/api/next')).body;
    const item = next.yourTurn.find((x) => x.card === card.id);
    assert.deepEqual([item.what, item.action], ['Valmis katselmoitavaksi', 'Hyväksy työ projektiin']);
    assert.match(item.detail, /1 korttia odottaa tätä/);
    assert.ok(next.waiting.some((w) => w.includes(`kortin "${card.title}"`) && w.includes('(nyt Review)')), next.waiting.join('|'));
    await server.store.update(card.id, { status: 'archive' });
    await server.store.update(waiting.id, { status: 'archive' });
  });

  test('refuses and leaves the repo alone when it has uncommitted changes or is on another branch', async () => {
    const { card } = await reviewCard('guard.js');
    const repo = join(reposRoot, 'local');
    const tip = sh(repo, 'rev-parse', 'HEAD');

    writeFileSync(join(repo, 'mine.txt'), 'my own work');
    const dirty = await call('POST', `/api/cards/${card.id}/merge`);
    assert.equal(dirty.status, 400);
    assert.match(dirty.body.error, /not committed/);
    rmSync(join(repo, 'mine.txt'));

    sh(repo, 'checkout', '-q', '-b', 'elsewhere');
    const wrong = await call('POST', `/api/cards/${card.id}/merge`);
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /branch elsewhere.*main/);
    sh(repo, 'checkout', '-q', 'main');
    sh(repo, 'branch', '-q', '-D', 'elsewhere');

    assert.equal(sh(repo, 'rev-parse', 'HEAD'), tip);
    assert.equal((await call('GET', `/api/cards/${card.id}`)).body.status, 'review');
    await server.store.update(card.id, { status: 'archive' });
  });

  test('a conflict is reported and the repo is put back exactly as it was', async () => {
    const { card } = await reviewCard('clash.js');
    const repo = join(reposRoot, 'local');
    writeFileSync(join(repo, 'clash.js'), 'export const v = "someone else";\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'main got there first');
    const tip = sh(repo, 'rev-parse', 'HEAD');

    const res = await call('POST', `/api/cards/${card.id}/merge`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /conflicts with changes already in main, in: clash\.js/);
    assert.equal(res.body.conflict, true, 'the page offers to let the agent resolve it');
    assert.deepEqual(res.body.files, ['clash.js']);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), tip);
    assert.equal(sh(repo, 'status', '--porcelain'), '', 'no half-finished merge left behind');
    assert.equal((await call('GET', `/api/cards/${card.id}`)).body.status, 'review');
    await server.store.update(card.id, { status: 'archive' });
  });

  test('work whose branch did not start from the target is accepted only once the person confirms', async () => {
    const { card } = await reviewCard('elsewhere.js');
    const repo = join(reposRoot, 'local');
    sh(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'side.txt'), 'side\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'side');
    const side = sh(repo, 'rev-parse', 'HEAD');
    sh(repo, 'checkout', '-q', 'main');
    const runFile = join(data, 'cards', card.id, 'run.json');
    const run = JSON.parse(readFileSync(runFile, 'utf8'));
    writeFileSync(runFile, JSON.stringify({ ...run, worktrees: [{ ...run.worktrees[0], forkSha: side }] }));
    const tip = sh(repo, 'rev-parse', 'HEAD');

    const refused = await call('POST', `/api/cards/${card.id}/merge`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.confirm, true);
    assert.match(refused.body.error, /no longer starts from where it was made/);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), tip, 'nothing merged');
    assert.equal((await call('POST', `/api/cards/${card.id}/merge`, { confirmed: true })).status, 200);
    sh(repo, 'branch', '-q', '-D', 'side');
  });

  test('conflicts can only be handed to the agent for finished work', async () => {
    const card = (await call('POST', '/api/cards', { title: 'Ei ajettu', repos: ['local'] })).body;
    const res = await call('POST', `/api/cards/${card.id}/resolve-conflicts`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /finished work/);
  });

  test('only cards in review can be merged', async () => {
    const card = (await call('POST', '/api/cards', { title: 'Ei vielä', repos: ['local'] })).body;
    const res = await call('POST', `/api/cards/${card.id}/merge`);
    assert.equal(res.status, 400);
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.localMerge, false);
  });
});

describe('a repository on Azure DevOps keeps the pull request path', () => {
  test('no local merge is offered when origin is an Azure DevOps repo', async () => {
    const azRepo = join(reposRoot, 'azrepo');
    await mkdir(azRepo);
    sh(azRepo, 'init', '-q', '-b', 'main');
    writeFileSync(join(azRepo, 'a.txt'), 'a');
    sh(azRepo, 'add', '.');
    sh(azRepo, 'commit', '-qm', 'init');
    const { card } = await reviewCard('az.js', 'azrepo');
    // Added only now: creating the worktree fetches origin, and a made-up host must never be contacted (it opens a login window).
    sh(azRepo, 'remote', 'add', 'origin', 'https://dev.azure.com/acme/P/_git/azrepo');
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.localMerge, false);
    assert.equal((await call('POST', `/api/cards/${card.id}/merge`)).status, 400);
    const item = (await call('GET', '/api/next')).body.yourTurn.find((x) => x.card === card.id);
    assert.equal(item.action, 'Katselmoi ja luo PR');
  });
});

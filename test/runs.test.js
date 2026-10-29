import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';

const fake = fileURLToPath(new URL('./fake-agents.js', import.meta.url));
const token = 't';
const headers = { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

let dir, state, data, reposRoot, server, runner, base, clock;
const windows = []; // console windows the runner asked to open (a fake: no real window)
const trusted = []; // folders the runner asked to mark trusted (a fake: never the real Claude config)
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const newCard = async (extra = {}) => {
  const card = (await call('POST', '/api/cards', { title: 'Add login', brief: 'make it so', repos: ['demo'], ...extra })).body;
  return card;
};
const ready = async (extra) => {
  const card = await newCard(extra);
  await server.store.update(card.id, { status: 'ready' });
  return card;
};
const getCard = async (id) => (await call('GET', `/api/cards/${id}`)).body;
const getRun = (id) => JSON.parse(readFileSync(join(data, 'cards', id, 'run.json'), 'utf8'));
const ageRun = (id) => {
  const run = getRun(id);
  run.updatedAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(data, 'cards', id, 'run.json'), JSON.stringify(run));
};
const jobs = () => JSON.parse(readFileSync(join(state, 'jobs.json'), 'utf8'));
const setJob = (id, patch) => {
  const all = jobs();
  const job = all.find((j) => j.id === id);
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete job[k]; else job[k] = v; }
  writeFileSync(join(state, 'jobs.json'), JSON.stringify(all));
};
const calls = () => (existsSync(join(state, 'calls.log')) ? readFileSync(join(state, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse) : []);
const cardFile = (id, name) => join(data, 'cards', id, name);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-runs-'));
  state = join(dir, 'fake-state');
  data = join(dir, 'data');
  reposRoot = join(dir, 'repos');
  await mkdir(state, { recursive: true });
  await mkdir(reposRoot, { recursive: true });
  Object.assign(process.env, {
    FAKE_STATE: state, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  });
  // A repo with an origin whose main is ahead of nothing local, so worktrees fork from origin/main.
  sh(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  sh(reposRoot, 'clone', '-q', join(dir, 'origin.git'), 'demo');
  writeFileSync(join(reposRoot, 'demo', 'a.txt'), 'v1\n');
  sh(join(reposRoot, 'demo'), 'add', '.');
  sh(join(reposRoot, 'demo'), 'commit', '-qm', 'init');
  sh(join(reposRoot, 'demo'), 'push', '-q', 'origin', 'HEAD:main');
  sh(join(reposRoot, 'demo'), 'fetch', '-q', 'origin');
  sh(join(reposRoot, 'demo'), 'remote', 'set-head', 'origin', 'main');

  clock = new Date(2026, 9, 13, 12, 0); // noon: day limit applies
  server = createApp({
    dataDir: data, token, reposRoot,
    claude: createClaude({ command: process.execPath, prefixArgs: [fake] }),
    runner: { dayLimit: 2, nightLimit: 3, now: () => clock, tickMs: 3600_000, trust: async (folders) => { trusted.push(...folders); }, openWindow: async (argv, title) => { windows.push({ argv, title }); } },
  });
  runner = server.runner;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});
// Cards from earlier tests must not occupy WIP slots.
beforeEach(async () => {
  runner.setEnabled(true);
  for (const c of (await call('GET', '/api/cards')).body) await server.store.update(c.id, { status: 'archive' });
});

describe('dispatching', () => {
  test('starts a ready card in its own worktree forked from origin/main', async () => {
    const card = await ready();
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'running');
    const run = getRun(card.id);
    assert.equal(run.state, 'running');
    assert.match(run.agentId, /^[0-9a-f]{8}$/);
    const wt = run.worktrees[0];
    assert.equal(wt.base, 'origin/main');
    assert.match(wt.branch, /^ac\/c-[a-z0-9]+-add-login$/);
    assert.equal(sh(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'), wt.branch);
    assert.equal(sh(wt.path, 'rev-parse', 'HEAD'), sh(join(reposRoot, 'demo'), 'rev-parse', 'origin/main'));

    assert.ok(trusted.includes(wt.path), 'the worktree is trusted before the agent starts in it');
    const prompt = readFileSync(cardFile(card.id, 'prompt.md'), 'utf8');
    assert.match(prompt, /# Task: Add login/);
    assert.match(prompt, /Never push/);
    assert.ok(prompt.includes(wt.path));

    const started = calls().findLast((c) => c.args[0] === '--bg');
    assert.match(started.args[1], /^Read .*prompt\.md and carry out/);
    assert.equal(started.args[started.args.indexOf('--permission-mode') + 1], 'auto', 'unattended agents should rarely stall on prompts');
    assert.ok(started.args.includes('Bash(git push:*)'), 'push is disallowed');
    assert.equal(realpathSync.native(started.cwd), realpathSync.native(wt.path));
    assert.equal(started.args[started.args.indexOf('--add-dir') + 1], realpathSync.native(join(data, 'cards', card.id)));
  });

  test('the agent can be opened in a console window to answer its permission prompt', async () => {
    const card = await ready();
    await runner.tick();
    const { agentId } = getRun(card.id);
    const res = await call('POST', `/api/cards/${card.id}/run/attach`);
    assert.equal(res.status, 200);
    assert.deepEqual(windows.at(-1).argv.slice(-2), ['attach', agentId]);
    const idle = await newCard();
    assert.equal((await call('POST', `/api/cards/${idle.id}/run/attach`)).status, 400, 'no agent yet');
  });

  test('images pasted into the card are listed in the agent\'s task, inside the card folder it may read', async () => {
    const card = await newCard({ title: 'Match the mock-up' });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex');
    const res = await fetch(`${base}/api/cards/${card.id}/attachments`, { method: 'POST', headers: { Cookie: 'ac_token=t', 'Content-Type': 'image/png' }, body: png });
    const { name } = await res.json();
    await server.store.update(card.id, { status: 'ready' });
    await runner.tick();
    const prompt = readFileSync(cardFile(card.id, 'prompt.md'), 'utf8');
    assert.match(prompt, /## Attached images/);
    assert.ok(prompt.includes(join(realpathSync.native(join(data, 'cards', card.id)), 'attachments', name)));
  });

  test('shows what the agent changed against the base, and survives a cleaned-up worktree', async () => {
    const card = await ready();
    await runner.tick();
    const wt = getRun(card.id).worktrees[0];
    assert.deepEqual((await call('GET', `/api/cards/${card.id}/diff`)).body.repos[0].patch, '', 'nothing committed yet');
    writeFileSync(join(wt.path, 'a.txt'), 'v1\nv2\n');
    sh(wt.path, 'commit', '-qam', 'change a');
    const [r] = (await call('GET', `/api/cards/${card.id}/diff`)).body.repos;
    assert.equal(r.repo, 'demo');
    assert.equal(r.base, 'origin/main');
    assert.match(r.patch, /^\+v2$/m);
    assert.match(r.stat, /a\.txt/);
    await rm(wt.path, { recursive: true, force: true });
    assert.equal((await call('GET', `/api/cards/${card.id}/diff`)).body.repos[0].gone, true);
    assert.equal((await call('GET', '/api/cards/c-missing/diff')).status, 404);
  });

  test('respects the WIP limit, priority and "start after"', async () => {
    const dep = await newCard({ title: 'dep' });
    const waiting = await ready({ title: 'waits', after: dep.id });
    const low = await ready({ title: 'low', priority: 'low' });
    const high = await ready({ title: 'high', priority: 'high' });
    const normal = await ready({ title: 'normal' });
    await runner.tick();
    const status = async (c) => (await getCard(c.id)).status;
    assert.equal(await status(high), 'running');
    assert.equal(await status(normal), 'running');
    assert.equal(await status(low), 'ready', 'limit is 2');
    assert.equal(await status(waiting), 'ready');
    assert.deepEqual(await runner.status(), { night: false, limit: 2, running: 2, enabled: true });
  });

  test('uses the night limit at night and can be paused', async () => {
    clock = new Date(2026, 9, 13, 23, 30);
    assert.equal((await runner.status()).limit, 3);
    clock = new Date(2026, 9, 13, 3, 0);
    assert.equal((await runner.status()).limit, 3);
    clock = new Date(2026, 9, 13, 12, 0);
    runner.setEnabled(false);
    const card = await ready();
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'ready');
  });

  test('a failure while starting leaves the card in needs_input with the reason', async () => {
    const card = await ready({ repos: ['missing-repo'] });
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'needs_input');
    const run = getRun(card.id);
    assert.equal(run.state, 'failed');
    assert.match(run.error, /Repository not found/);
    assert.equal((await call('POST', `/api/cards/${card.id}/run/retry`)).status, 202);
    assert.equal((await getCard(card.id)).status, 'ready', 'no agent yet, so retry re-queues');
  });

  test('a start interrupted by a restart is re-queued and started again', async () => {
    const card = await newCard();
    await server.store.update(card.id, { status: 'running' });
    writeFileSync(cardFile(card.id, 'run.json'), JSON.stringify({ state: 'starting', agentId: null, worktrees: [], replies: 0 }));
    await runner.tick();
    assert.equal(getRun(card.id).state, 'running');
    assert.equal((await getCard(card.id)).status, 'running');
  });
});

describe('watching', () => {
  const startOne = async (extra) => {
    const card = await ready(extra);
    await runner.tick();
    return { card, run: getRun(card.id) };
  };

  test('report.md finishes the card, moves it to review and stops the idle job', async () => {
    const { card, run } = await startOne();
    writeFileSync(cardFile(card.id, 'report.md'), 'did it');
    setJob(run.agentId, { status: 'idle', state: 'done' });
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'review');
    assert.equal(getRun(card.id).state, 'finished');
    assert.ok(calls().some((c) => c.args[0] === 'stop' && c.args[1] === run.agentId));
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.report, 'did it');
  });

  test('a fresh report while the agent is still busy waits out a grace period', async () => {
    const { card } = await startOne();
    writeFileSync(cardFile(card.id, 'report.md'), 'early');
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'running');
    const old = new Date(Date.now() - 120_000);
    utimesSync(cardFile(card.id, 'report.md'), old, old);
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'review');
  });

  test('a permission prompt moves the card to needs_input and back when it clears', async () => {
    const { card, run } = await startOne();
    setJob(run.agentId, { status: 'waiting', state: 'blocked', waitingFor: 'permission prompt' });
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'needs_input');
    assert.equal(getRun(card.id).waitingFor, 'permission prompt');
    setJob(run.agentId, { status: 'busy', state: 'working', waitingFor: undefined });
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'running');
    assert.equal(getRun(card.id).waitingFor, null);
  });

  test('an agent from the stricter mode that stalls on a prompt continues by itself in auto mode, once', async () => {
    const { card, run } = await startOne();
    const r = getRun(card.id);
    delete r.permissionMode; // as runs started before agents ran in auto mode
    writeFileSync(join(data, 'cards', card.id, 'run.json'), JSON.stringify(r));
    const { sessionId } = jobs().find((j) => j.id === run.agentId);
    setJob(run.agentId, { status: 'waiting', state: 'blocked', waitingFor: 'permission prompt' });
    await runner.tick();

    const resumed = calls().findLast((c) => c.args[0] === '--bg');
    assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], sessionId, 'the same conversation continues');
    assert.equal(resumed.args[resumed.args.indexOf('--permission-mode') + 1], 'auto');
    assert.ok(resumed.args.includes('Bash(git push:*)'), 'push stays disallowed');
    const after = getRun(card.id);
    assert.notEqual(after.agentId, run.agentId);
    assert.deepEqual([after.state, after.permissionMode, after.modeSwitched, after.waitingFor], ['running', 'auto', true, null]);
    assert.equal((await getCard(card.id)).status, 'running');
    assert.equal(jobs().find((j) => j.id === run.agentId).state, 'done', 'the stalled job was stopped');

    // Stalling again after the switch is the person's to answer: no endless restarts.
    setJob(after.agentId, { status: 'waiting', state: 'blocked', waitingFor: 'permission prompt' });
    await runner.tick();
    assert.equal(getRun(card.id).agentId, after.agentId);
    assert.equal((await getCard(card.id)).status, 'needs_input');
  });

  test('question.md asks the person; the answer wakes the same session without flags', async () => {
    const { card, run } = await startOne();
    writeFileSync(cardFile(card.id, 'question.md'), 'A or B?');
    setJob(run.agentId, { status: 'idle', state: 'done' });
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'needs_input');
    assert.equal((await call('GET', `/api/cards/${card.id}/run`)).body.question, 'A or B?');

    assert.equal((await call('POST', `/api/cards/${card.id}/run/answer`, { message: '' })).status, 400, 'an answer is required');
    assert.equal((await call('POST', `/api/cards/${card.id}/run/answer`, { message: 'use B' })).status, 202);

    const wake = calls().findLast((c) => c.args.includes('--resume'));
    assert.deepEqual(wake.args.slice(0, 2), ['--bg', '--resume']);
    assert.equal(wake.args.length, 4, 'no flags, so the saved options and id are kept');
    assert.match(wake.args[3], /A person replied\. Read .*1\.md/);
    assert.equal(readFileSync(join(data, 'cards', card.id, 'replies', '1.md'), 'utf8'), 'use B');
    assert.ok(!existsSync(cardFile(card.id, 'question.md')) && existsSync(cardFile(card.id, 'question.1.md')));
    assert.equal(getRun(card.id).agentId, run.agentId);
    assert.equal(jobs().find((j) => j.id === run.agentId).wakes, 1);
    assert.equal((await getCard(card.id)).status, 'running');
    assert.equal((await call('POST', `/api/cards/${card.id}/run/answer`, { message: 'again' })).status, 400, 'still working');
  });

  test('right after starting, status undefined + state working still counts as working', async () => {
    const { card, run } = await startOne();
    setJob(run.agentId, { status: undefined, state: 'working' });
    ageRun(card.id);
    for (let i = 0; i < 3; i++) await runner.tick();
    assert.equal((await getCard(card.id)).status, 'running');
  });

  test('"not working" is ignored for a few seconds after a (re)start', async () => {
    const { card, run } = await startOne();
    setJob(run.agentId, { status: 'idle', state: 'done' });
    for (let i = 0; i < 3; i++) await runner.tick();
    assert.equal((await getCard(card.id)).status, 'running');
  });

  test('an agent that ends without a report fails after two observations, not one', async () => {
    const { card, run } = await startOne();
    ageRun(card.id);
    setJob(run.agentId, { status: 'idle', state: 'done' });
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'running');
    setJob(run.agentId, { status: 'busy', state: 'working' });
    await runner.tick(); // recovered: the miss counter resets
    setJob(run.agentId, { status: 'idle', state: 'done' });
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'running');
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'needs_input');
    assert.match(getRun(card.id).error, /without writing report\.md/);
  });

  test('stop, then retry continues the session', async () => {
    const { card, run } = await startOne();
    assert.equal((await call('POST', `/api/cards/${card.id}/run/stop`)).status, 202);
    assert.equal(getRun(card.id).state, 'stopped');
    assert.equal((await getCard(card.id)).status, 'needs_input');
    assert.equal((await call('POST', `/api/cards/${card.id}/run/retry`)).status, 202);
    assert.equal(getRun(card.id).state, 'running');
    assert.equal(getRun(card.id).agentId, run.agentId);
    assert.equal((await call('POST', `/api/cards/${card.id}/run/stop`)).status, 202);
    assert.equal((await call('POST', `/api/cards/${card.id}/run/stop`)).status, 400, 'nothing left to stop');
  });

  test('other (interactive) sessions in `claude agents` are ignored', async () => {
    const { card, run } = await startOne();
    await runner.tick();
    assert.equal((await getCard(card.id)).status, 'running');
    assert.equal(getRun(card.id).agentId, run.agentId);
  });
});

describe('prompt', () => {
  test('carries the approved plan and the decisions made while refining', async () => {
    const card = await newCard();
    const refineFile = join(data, 'cards', card.id, 'refine.json');
    writeFileSync(refineFile, JSON.stringify({
      state: 'idle', turn: 2, plan: 'Step 1: do the thing', questions: [], ready: true, cost: 0,
      history: [{ turn: 1, answers: { q1: 'B' }, questions: [{ id: 'q1', text: 'Which provider?' }], message: 'keep it small' }],
    }));
    await server.store.update(card.id, { status: 'ready', model: 'sonnet' });
    await runner.tick();
    const prompt = readFileSync(cardFile(card.id, 'prompt.md'), 'utf8');
    assert.match(prompt, /## Approved plan\n\nStep 1: do the thing/);
    assert.match(prompt, /- Which provider\? → B/);
    assert.match(prompt, /Message from the person: keep it small/);
    const started = calls().findLast((c) => c.args[0] === '--bg');
    assert.equal(started.args[started.args.indexOf('--model') + 1], 'sonnet');
    assert.equal(getRun(card.id).model, 'sonnet');
  });

  test('the agent runs on the project\'s model and effort unless the card chose its own', async () => {
    const flag = (c, name) => (c.args.includes(name) ? c.args[c.args.indexOf(name) + 1] : undefined);
    await call('POST', '/api/projects', { name: 'tuned', model: 'opus', effort: 'high' });

    const inherits = await ready({ repos: ['tuned'] });
    await runner.tick();
    let started = calls().findLast((c) => c.args[0] === '--bg');
    assert.deepEqual([flag(started, '--model'), flag(started, '--effort')], ['opus', 'high']);
    assert.deepEqual([getRun(inherits.id).model, getRun(inherits.id).effort], ['opus', 'high'], 'kept in the run, so a resumed agent keeps it');

    const own = await ready({ repos: ['tuned'], model: 'haiku' });
    await runner.tick();
    started = calls().findLast((c) => c.args[0] === '--bg');
    assert.deepEqual([flag(started, '--model'), flag(started, '--effort')], ['haiku', 'high']);
    assert.equal(getRun(own.id).model, 'haiku');

    for (const c of [inherits, own]) await server.store.update(c.id, { status: 'archive' }); // free the two WIP slots
    const plain = await ready(); // repo "demo" is no project
    await runner.tick();
    started = calls().findLast((c) => c.args[0] === '--bg');
    assert.deepEqual([flag(started, '--model'), flag(started, '--effort')], [undefined, undefined]);
    assert.equal(getRun(plain.id).model, null);
  });
});

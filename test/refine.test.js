import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude, resolveClaudeExecutable } from '../lib/claude.js';

const fake = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const token = 't';
const headers = { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' };

let dir, reposRoot, logFile, server, base;
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const newCard = async (extra = {}) => (await call('POST', '/api/cards', { title: 'T', brief: 'do it', repos: ['repo-a'], ...extra })).body;
const invocations = async () => (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-refine-'));
  reposRoot = join(dir, 'repos');
  await mkdir(join(reposRoot, 'repo-a'), { recursive: true });
  logFile = join(dir, 'fake.log');
  process.env.FAKE_LOG = logFile;
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  server = createApp({ dataDir: join(dir, 'data'), token, reposRoot, claude: createClaude({ command: process.execPath, prefixArgs: [fake] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe('refinement', () => {
  test('first turn asks questions, answer turn resumes the session and finishes the plan', async () => {
    const card = await newCard();
    const started = await call('POST', `/api/cards/${card.id}/refine/start`);
    assert.equal(started.status, 202);
    await server.refiner.settled();

    let r = (await call('GET', `/api/cards/${card.id}/refine`)).body;
    assert.equal(r.state, 'idle');
    assert.equal(r.sessionId, 'fake-session');
    assert.equal(r.questions.length, 1);
    assert.equal(r.ready, false, 'ready is forced false while questions are open');
    assert.equal((await call('GET', `/api/cards/${card.id}`)).body.status, 'refining');

    const first = (await invocations()).at(-1);
    assert.equal(first.cwd, join(reposRoot, 'repo-a'));
    assert.ok(first.args.includes('--json-schema'));
    assert.equal(first.args[first.args.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(first.args.includes('--disallowedTools'));
    assert.ok(!first.args.includes('--resume'));
    assert.match(first.prompt, /Brief:\ndo it/);

    assert.equal((await call('POST', `/api/cards/${card.id}/refine/answer`, { answers: { q1: 'B' } })).status, 202);
    await server.refiner.settled();
    r = (await call('GET', `/api/cards/${card.id}/refine`)).body;
    assert.equal(r.ready, true);
    assert.equal(r.plan, 'Final plan');
    assert.equal(r.turn, 2);
    assert.equal(r.cost, 0.02);

    const second = (await invocations()).at(-1);
    assert.equal(second.args[second.args.indexOf('--resume') + 1], 'fake-session');
    assert.match(second.prompt, /Which provider\?\n {2}Answer: B/);

    const approved = await call('POST', `/api/cards/${card.id}/refine/approve`, {});
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'ready');
  });

  test('unanswered questions fall back to the recommendation', async () => {
    const card = await newCard();
    await call('POST', `/api/cards/${card.id}/refine/start`);
    await server.refiner.settled();
    await call('POST', `/api/cards/${card.id}/refine/answer`, { answers: {} });
    await server.refiner.settled();
    assert.match((await invocations()).at(-1).prompt, /use your recommendation: A/);
  });

  test('live log records tool use and result', async () => {
    const card = await newCard();
    await call('POST', `/api/cards/${card.id}/refine/start`);
    await server.refiner.settled();
    const tail = await server.refiner.liveTail(card.id);
    assert.ok(tail.some((e) => e.kind === 'tool' && e.name === 'Read' && e.summary === 'src/app.js'));
    assert.ok(tail.some((e) => e.kind === 'text'));
    assert.ok(tail.some((e) => e.kind === 'result' && e.ok));
  });

  test('the model and effort come from the card, else its project, else the default', async () => {
    const flag = (inv, name) => (inv.args.includes(name) ? inv.args[inv.args.indexOf(name) + 1] : undefined);
    await call('POST', '/api/projects', { name: 'tuned', model: 'opus', effort: 'high' });

    const plain = await newCard({ repos: ['repo-a'] }); // a folder that is no project
    await call('POST', `/api/cards/${plain.id}/refine/start`);
    await server.refiner.settled();
    const none = (await invocations()).at(-1);
    assert.deepEqual([flag(none, '--model'), flag(none, '--effort')], [undefined, undefined]);

    const inherits = await newCard({ repos: ['tuned'] });
    await call('POST', `/api/cards/${inherits.id}/refine/start`);
    await server.refiner.settled();
    const first = (await invocations()).at(-1);
    assert.deepEqual([flag(first, '--model'), flag(first, '--effort')], ['opus', 'high']);

    await call('POST', '/api/projects/tuned/settings', { model: 'sonnet', effort: '' });
    await call('POST', `/api/cards/${inherits.id}/refine/answer`, { answers: { q1: 'A' } });
    await server.refiner.settled();
    const later = (await invocations()).at(-1);
    assert.deepEqual([flag(later, '--model'), flag(later, '--effort')], ['sonnet', undefined], 'a later turn follows the project as it is now');

    const own = await newCard({ repos: ['tuned'], model: 'haiku' });
    await call('POST', '/api/projects/tuned/settings', { effort: 'max' });
    await call('POST', `/api/cards/${own.id}/refine/start`);
    await server.refiner.settled();
    const mixed = (await invocations()).at(-1);
    assert.deepEqual([flag(mixed, '--model'), flag(mixed, '--effort')], ['haiku', 'max'], 'the card wins for what it sets, the project fills the rest');
  });

  test('rejects unknown and traversing repo names before launching', async () => {
    for (const repos of [['nope'], ['../etc'], ['a/b']]) {
      const card = await newCard({ repos });
      const res = await call('POST', `/api/cards/${card.id}/refine/start`);
      assert.equal(res.status, 400, JSON.stringify(repos));
    }
  });

  test('a crashing claude leaves the card in an error state', async () => {
    const card = await newCard({ brief: 'FAIL please' });
    assert.equal((await call('POST', `/api/cards/${card.id}/refine/start`)).status, 202);
    await server.refiner.settled();
    const r = (await call('GET', `/api/cards/${card.id}/refine`)).body;
    assert.equal(r.state, 'error');
    assert.match(r.error, /simulated crash/);
    assert.equal((await call('POST', `/api/cards/${card.id}/refine/approve`, {})).status, 400);
  });

  test('a card whose dependency is not met is refined only after confirmation', async () => {
    const a = await newCard({ title: 'A' });
    const b = await newCard({ title: 'B', after: a.id });
    const c = await newCard({ title: 'C', after: a.id, afterKind: 'planned' });

    const refused = await call('POST', `/api/cards/${b.id}/refine/start`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.confirm, true);
    assert.deepEqual(refused.body.blockedBy, { id: a.id, title: 'A', status: 'inbox' });
    assert.equal(refused.body.afterKind, 'done');
    assert.equal((await call('GET', `/api/cards/${b.id}`)).body.status, 'inbox', 'nothing started');

    assert.equal((await call('POST', `/api/cards/${b.id}/refine/start`, { confirmed: true })).status, 202);
    await server.refiner.settled();
    assert.equal((await call('GET', `/api/cards/${b.id}`)).body.status, 'refining');

    await server.store.update(a.id, { status: 'ready' });
    assert.equal((await call('POST', `/api/cards/${c.id}/refine/start`)).status, 202, 'an approved plan is enough for "planned"');
    await server.refiner.settled();
  });

  test('approve needs a ready plan unless forced', async () => {
    const card = await newCard();
    await call('POST', `/api/cards/${card.id}/refine/start`);
    await server.refiner.settled();
    assert.equal((await call('POST', `/api/cards/${card.id}/refine/approve`, {})).status, 400);
    assert.equal((await call('POST', `/api/cards/${card.id}/refine/approve`, { force: true })).body.status, 'ready');
  });

  test('a turn cut off by a restart is re-run on start-up', async () => {
    const card = await newCard();
    await writeFile(join(dir, 'data', 'cards', card.id, 'refine.json'), JSON.stringify({
      state: 'running', sessionId: null, turn: 1, summary: '', questions: [], plan: '', ready: false,
      history: [], cost: 0, error: null, pendingPrompt: 'Ticket: T', updatedAt: null,
    }));
    await server.refiner.resumeInterrupted();
    await server.refiner.settled();
    const r = (await call('GET', `/api/cards/${card.id}/refine`)).body;
    assert.equal(r.state, 'idle');
    assert.equal(r.turn, 1);
    assert.equal(r.questions.length, 1);
  });

  test('live endpoint streams the backlog as server-sent events', async () => {
    const card = await newCard();
    await call('POST', `/api/cards/${card.id}/refine/start`);
    await server.refiner.settled();
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/cards/${card.id}/live`, { headers, signal: ctl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /^data: \{.*"kind":"turn"/);
    ctl.abort();
  });
});

describe('claude runner', () => {
  test('AGENTCONTROL_CLAUDE overrides executable lookup', () => {
    assert.equal(resolveClaudeExecutable({ AGENTCONTROL_CLAUDE: 'C:\\x\\claude.exe' }), 'C:\\x\\claude.exe');
  });

  test('retries only start failures, then gives up', async () => {
    const claude = createClaude({ command: join(dir, 'does-not-exist.exe'), retries: 3, retryDelayMs: 1 });
    await assert.rejects(claude.run({ args: [], cwd: dir, prompt: '' }), (e) => e.startFailure === true && e.code === 'ENOENT');
  });

  test('reports a missing result when the process exits cleanly without one', async () => {
    const claude = createClaude({ command: process.execPath, prefixArgs: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'] });
    await assert.rejects(claude.run({ args: [], cwd: dir, prompt: 'x' }), /without a result/);
  });
});

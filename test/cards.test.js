import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { NotFoundError, ValidationError, createCardStore, dependsOn, unmetDependencies, unmetDependency } from '../lib/cards.js';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'agentcontrol-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe('card store', () => {
  test('create, get, list, update', async () => {
    const store = createCardStore(join(dir, 'store'));
    assert.deepEqual(await store.list(), []);
    const a = await store.create({ title: ' First ', brief: 'do it', repos: ['r1', ' '], priority: 'high' });
    assert.equal(a.title, 'First');
    assert.equal(a.status, 'inbox');
    assert.deepEqual(a.repos, ['r1']);
    const b = await store.create({ title: 'Second', after: a.id });
    assert.deepEqual(b.deps, [{ id: a.id, kind: 'done' }], 'the old single after still works');
    assert.equal(b.kind, 'task');
    assert.equal((await store.list()).length, 2);
    const moved = await store.update(a.id, { status: 'ready' });
    assert.equal(moved.status, 'ready');
    assert.equal((await store.get(a.id)).status, 'ready');
  });

  test('a dependency waits for the implementation or only for the plan', async () => {
    const store = createCardStore(join(dir, 'deps'));
    const a = await store.create({ title: 'A' });
    const b = await store.create({ title: 'B', after: a.id });
    assert.equal(b.deps[0].kind, 'done', 'implementation is the default');
    const c = await store.create({ title: 'C', after: a.id, afterKind: 'planned' });
    const no = await store.create({ title: 'D' });
    assert.deepEqual(no.deps, []);
    await assert.rejects(store.create({ title: 'E', after: a.id, afterKind: 'soon' }), ValidationError);

    const at = (status) => [{ ...a, status }, b, c];
    assert.equal(unmetDependency(b, at('refining'))?.id, a.id);
    assert.equal(unmetDependency(c, at('refining'))?.id, a.id);
    assert.equal(unmetDependency(b, at('ready'))?.id, a.id, 'planned is not enough for "done"');
    assert.equal(unmetDependency(c, at('ready')), null, 'an approved plan is enough for "planned"');
    assert.equal(unmetDependency(b, at('done')), null);
    assert.equal(unmetDependency(no, at('inbox')), null);
  });

  test('dependencies can be changed, but not into a cycle', async () => {
    const store = createCardStore(join(dir, 'cycle'));
    const a = await store.create({ title: 'A' });
    const b = await store.create({ title: 'B', after: a.id });
    const c = await store.create({ title: 'C' });
    assert.deepEqual(await store.update(c.id, { after: b.id, afterKind: 'planned' }).then((x) => x.deps), [{ id: b.id, kind: 'planned' }]);
    await assert.rejects(store.update(a.id, { after: c.id }), /cycle/);
    await assert.rejects(store.update(a.id, { after: a.id }), /cycle/);
    assert.deepEqual(await store.update(c.id, { after: null }).then((x) => x.deps), []);
  });

  test('a card can wait for several cards, and waits until all of them are ready', async () => {
    const store = createCardStore(join(dir, 'multi'));
    const a = await store.create({ title: 'A' });
    const b = await store.create({ title: 'B' });
    const c = await store.create({ title: 'C', deps: [{ id: a.id }, { id: b.id, kind: 'planned' }, { id: a.id, kind: 'planned' }] });
    assert.deepEqual(c.deps, [{ id: a.id, kind: 'done' }, { id: b.id, kind: 'planned' }], 'duplicates merge, the first kind stays');
    const at = (sa, sb) => [{ ...a, status: sa }, { ...b, status: sb }, c];
    assert.deepEqual(unmetDependencies(c, at('inbox', 'inbox')).map((u) => u.dep.id), [a.id, b.id]);
    assert.equal(unmetDependency(c, at('done', 'inbox'))?.id, b.id);
    assert.equal(unmetDependency(c, at('done', 'ready')), null);
    assert.ok(dependsOn(c, b.id));
    // A cycle through any of the dependencies is refused; a whole list replaces the old one.
    const d = await store.create({ title: 'D', deps: [c.id] });
    await assert.rejects(store.update(b.id, { deps: [{ id: a.id }, { id: d.id }] }), /cycle/);
    assert.deepEqual((await store.update(d.id, { deps: [a.id, b.id] })).deps.map((x) => x.id), [a.id, b.id]);
    await assert.rejects(store.update(d.id, { deps: [{ id: a.id, kind: 'soon' }] }), ValidationError);
    await assert.rejects(store.update(d.id, { deps: 'nope' }), ValidationError);
  });

  test('cards saved with the old single dependency read as a list of one', async () => {
    const store = createCardStore(join(dir, 'legacy'));
    const a = await store.create({ title: 'A' });
    const b = await store.create({ title: 'B' });
    const file = join(dir, 'legacy', 'cards', b.id, 'card.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    delete raw.deps; delete raw.kind;
    writeFileSync(file, JSON.stringify({ ...raw, after: a.id, afterKind: 'planned' }));
    const got = await store.get(b.id);
    assert.deepEqual(got.deps, [{ id: a.id, kind: 'planned' }]);
    assert.equal(got.kind, 'task');
    assert.equal('after' in got, false);
  });

  test('a research card', async () => {
    const store = createCardStore(join(dir, 'research'));
    const r = await store.create({ title: 'Selvitä X', kind: 'research' });
    assert.equal(r.kind, 'research');
    await assert.rejects(store.create({ title: 'x', kind: 'essay' }), ValidationError);
    await store.update(r.id, { status: 'running' });
    await assert.rejects(store.update(r.id, { kind: 'task' }), /cannot change/);
  });

  test('validation', async () => {
    const store = createCardStore(join(dir, 'store2'));
    await assert.rejects(store.create({ title: '  ' }), ValidationError);
    await assert.rejects(store.create({ title: 'x', priority: 'urgent' }), ValidationError);
    await assert.rejects(store.create({ title: 'x', after: 'c-nope' }), ValidationError);
    const c = await store.create({ title: 'x' });
    await assert.rejects(store.update(c.id, { status: 'bogus' }), ValidationError);
    await assert.rejects(store.get('../etc'), NotFoundError);
    await assert.rejects(store.get('c-missing'), NotFoundError);
  });
});

describe('http api', () => {
  const token = 'test-token';
  let server, base;
  before(async () => {
    server = createApp({ dataDir: join(dir, 'http'), token });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));

  const auth = { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' };

  test('rejects without token', async () => {
    assert.equal((await fetch(`${base}/api/cards`)).status, 401);
    assert.equal((await fetch(`${base}/?token=wrong`, { redirect: 'manual' })).status, 401);
  });

  test('token in URL sets cookie and redirects', async () => {
    const res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('set-cookie'), /ac_token=test-token; HttpOnly; SameSite=Strict/);
  });

  test('rejects foreign Host header', async () => {
    const port = server.address().port;
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/cards', headers: { Cookie: auth.Cookie, Host: 'evil.example' } },
        (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  test('create, patch, list over HTTP', async () => {
    const created = await fetch(`${base}/api/cards`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Hello' }) });
    assert.equal(created.status, 201);
    const card = await created.json();
    const patched = await fetch(`${base}/api/cards/${card.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'archive' }) });
    assert.equal((await patched.json()).status, 'archive');
    const list = await (await fetch(`${base}/api/cards`, { headers: auth })).json();
    assert.equal(list.length, 1);
    const bad = await fetch(`${base}/api/cards`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/cards/c-missing`, { headers: auth })).status, 404);
  });

  test('refuses hand-made moves that skip the process, allows the legal ones', async () => {
    const card = await (await fetch(`${base}/api/cards`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Moves' }) })).json();
    const move = (status) => fetch(`${base}/api/cards/${card.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status }) });
    for (const status of ['running', 'review', 'done', 'ready']) assert.equal((await move(status)).status, 400, `inbox -> ${status}`);
    assert.equal((await move('inbox')).status, 200, 'staying put is fine');
    assert.equal((await move('archive')).status, 200);
    assert.equal((await move('inbox')).status, 200, 'restore from archive');
    const meta = await (await fetch(`${base}/api/meta`, { headers: auth })).json();
    assert.deepEqual(meta.moves.running, []);
  });

  test('lists git repositories under the repos root', async () => {
    const names = await (await fetch(`${base}/api/repos`, { headers: auth })).json();
    assert.ok(Array.isArray(names));
  });
});

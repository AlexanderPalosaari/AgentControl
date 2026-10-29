import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';

const fake = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const headers = { Cookie: 'ac_token=t', 'Content-Type': 'application/json' };
let dir, server, base;
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const card = async (title, extra = {}) => (await call('POST', '/api/cards', { title, repos: ['repo-a'], ...extra })).body;
const status = (c, s) => server.store.update(c.id, { status: s });
const phases = async () => (await call('GET', '/api/phases')).body;
const cardFile = (c, name, data) => writeFile(join(dir, 'data', 'cards', c.id, name), JSON.stringify(data));

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-phases-'));
  await mkdir(join(dir, 'repos', 'repo-a'), { recursive: true });
  process.env.FAKE_LOG = join(dir, 'fake.log');
  server = createApp({ dataDir: join(dir, 'data'), token: 't', reposRoot: join(dir, 'repos'), claude: createClaude({ command: process.execPath, prefixArgs: [fake] }), runner: { dayLimit: 1, nightLimit: 1, nightStart: 3, nightEnd: 4 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

test('a card whose plan is ready stays in Refining but is labelled as waiting for the person', async () => {
  const c = await card('Suunniteltu');
  await status(c, 'refining');
  await cardFile(c, 'refine.json', { state: 'idle', turn: 1, summary: 's', questions: [], plan: 'Tee näin', ready: true, history: [], cost: 0 });
  const p = (await phases()).cards[c.id];
  assert.deepEqual([p.key, p.label, p.tone], ['plan-ready', 'Suunnitelma odottaa', 'you']);
});

test('a waiting card says what it waits for: its dependency or a free agent slot', async () => {
  const first = await card('Eka');
  const blocked = await card('Toinen', { after: first.id });
  const p = (await phases()).cards;
  assert.equal(p[blocked.id].key, 'inbox-blocked');
  assert.match(p[blocked.id].reason, /Odottaa korttia "Eka" \(valmistumista, nyt Inbox\)/);

  const busy = await card('Työssä');
  await status(busy, 'running');
  await cardFile(busy, 'run.json', { state: 'running', startedAt: new Date().toISOString(), worktrees: [], updatedAt: new Date().toISOString() });
  const a = await card('Jonossa A');
  const b = await card('Jonossa B');
  await status(a, 'ready');
  await status(b, 'ready');
  const q = (await phases()).cards;
  assert.equal(q[a.id].key, 'ready-full');
  assert.match(q[a.id].reason, /täynnä \(1\/1.*jonossa nro 1/);
  assert.match(q[b.id].reason, /jonossa nro 2/);
});

test('an agent that has changed nothing for a long time is flagged quiet', async () => {
  const c = await card('Hiljainen');
  await status(c, 'running');
  const old = new Date(Date.now() - 40 * 60_000).toISOString();
  await cardFile(c, 'run.json', { state: 'running', startedAt: old, worktrees: [], updatedAt: old });
  const { cards, usage } = await phases();
  assert.equal(cards[c.id].key, 'running-quiet');
  assert.match(cards[c.id].reason, /Ei muutoksia 40 min/);
  assert.ok(usage.runsToday >= 1 && usage.agentMinutes >= 0);
});

test('a paused dispatcher is named as the reason a ready card does not start', async () => {
  const c = await card('Pysäytetty jono');
  await status(c, 'ready');
  await call('POST', '/api/dispatcher', { enabled: false });
  assert.equal((await phases()).cards[c.id].key, 'ready-paused');
  await call('POST', '/api/dispatcher', { enabled: true });
});

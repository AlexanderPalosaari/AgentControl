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

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-next-'));
  await mkdir(join(dir, 'repos', 'repo-a'), { recursive: true });
  process.env.FAKE_LOG = join(dir, 'fake.log');
  server = createApp({ dataDir: join(dir, 'data'), token: 't', reposRoot: join(dir, 'repos'), claude: createClaude({ command: process.execPath, prefixArgs: [fake] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

test('an empty board needs nothing', async () => {
  assert.deepEqual((await call('GET', '/api/next')).body, { yourTurn: [], working: [], waiting: [] });
});

test('what needs the person comes first, most urgent first; what runs or waits is summed up', async () => {
  const review = await card('Valmis työ');
  await status(review, 'review');

  const asking = await card('Kysyvä agentti');
  await status(asking, 'needs_input');
  await writeFile(join(dir, 'data', 'cards', asking.id, 'question.md'), '# Kysymys\nKäytetäänkö Postgresia vai SQLitea?\n');

  const refining = await card('Tarkennettava');
  await call('POST', `/api/cards/${refining.id}/refine/start`, {});
  await server.refiner.settled(); // the fake refiner asks one question

  const running = await card('Työn alla');
  await status(running, 'running');

  const first = await card('Aloitettava');
  await card('Odottaa ekaa', { after: first.id });
  const queued = await card('Jonossa', { after: running.id });
  await status(queued, 'ready');
  const archived = await card('Vanha');
  await status(archived, 'archive');

  const { yourTurn, working, waiting } = (await call('GET', '/api/next')).body;
  assert.deepEqual(yourTurn.map((x) => [x.what, x.title, x.action]), [
    ['Agentti kysyy', 'Kysyvä agentti', 'Vastaa'],
    ['Tarkentaja kysyy (1)', 'Tarkennettava', 'Vastaa kysymyksiin'],
    ['Valmis katselmoitavaksi', 'Valmis työ', 'Katselmoi ja luo PR'],
    ['Inbox', 'Aloitettava', 'Aloita tarkennus'],
  ]);
  assert.equal(yourTurn[0].detail, 'Käytetäänkö Postgresia vai SQLitea?', 'the question itself, without the heading');
  assert.equal(yourTurn[0].card, asking.id);
  assert.equal(yourTurn[1].detail, 'Which provider?');
  assert.deepEqual(working, ['Toteutus: Työn alla']);
  assert.deepEqual(waiting, ['Ready, odottaa korttia "Työn alla": Jonossa', '1 kortti odottaa kortin "Aloitettava" toteutuksen valmistumista (Done) (nyt Inbox)']);
});

test('a stalled agent and a waiting project are the person\'s turn too', async () => {
  const stuck = await card('Jumissa');
  await status(stuck, 'needs_input');
  await writeFile(join(dir, 'data', 'cards', stuck.id, 'run.json'), JSON.stringify({ state: 'failed', error: 'claude exited with code 1', worktrees: [] }));
  await call('POST', '/api/projects', { name: 'uusi-projekti' });

  const { yourTurn } = (await call('GET', '/api/next')).body;
  const s = yourTurn.find((x) => x.card === stuck.id);
  assert.deepEqual([s.what, s.detail, s.action], ['Agentti pysähtyi', 'claude exited with code 1', 'Katso ja yritä uudelleen']);
  const p = yourTurn.find((x) => x.project === 'uusi-projekti');
  assert.deepEqual([p.what, p.action], ['Projekti odottaa kuvausta', 'Kuvaile projekti']);
});

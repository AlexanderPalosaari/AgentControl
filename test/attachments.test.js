import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';

const fake = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
// The smallest valid PNG: 1x1 transparent pixel.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex');
const cookie = { Cookie: 'ac_token=t' };

let dir, server, base, logFile;
const call = async (method, path, body, type = 'application/json') => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...cookie, 'Content-Type': type }, body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined });
  return { status: res.status, type: res.headers.get('content-type'), body: res.headers.get('content-type')?.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-att-'));
  await mkdir(join(dir, 'repos', 'repo-a'), { recursive: true });
  logFile = join(dir, 'fake.log');
  process.env.FAKE_LOG = logFile;
  server = createApp({ dataDir: join(dir, 'data'), token: 't', reposRoot: join(dir, 'repos'), claude: createClaude({ command: process.execPath, prefixArgs: [fake] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

test('a pasted image is stored with the card, listed and served back', async () => {
  const card = (await call('POST', '/api/cards', { title: 'Kuvallinen', repos: ['repo-a'] })).body;
  const added = await call('POST', `/api/cards/${card.id}/attachments`, PNG, 'image/png');
  assert.equal(added.status, 201);
  assert.match(added.body.name, /^kuva-[a-z0-9]+\.png$/);
  assert.deepEqual(await readFile(join(dir, 'data', 'cards', card.id, 'attachments', added.body.name)), PNG);

  const list = (await call('GET', `/api/cards/${card.id}/attachments`)).body;
  assert.deepEqual(list, [{ name: added.body.name, url: `/api/cards/${card.id}/attachments/${added.body.name}` }]);
  const got = await call('GET', list[0].url);
  assert.equal(got.type, 'image/png');
  assert.deepEqual(got.body, PNG);
});

test('only real images are accepted, and only by their own names', async () => {
  const card = (await call('POST', '/api/cards', { title: 'Tarkka' })).body;
  assert.equal((await call('POST', `/api/cards/${card.id}/attachments`, Buffer.from('hello'), 'text/plain')).status, 400);
  assert.equal((await call('POST', `/api/cards/${card.id}/attachments`, Buffer.from('not really a png'), 'image/png')).status, 400, 'the bytes must match the type');
  assert.equal((await call('POST', `/api/cards/${card.id}/attachments`, Buffer.alloc(0), 'image/png')).status, 400);
  assert.equal((await call('POST', '/api/cards/c-nope/attachments', PNG, 'image/png')).status, 404);
  assert.equal((await call('GET', `/api/cards/${card.id}/attachments/card.json`)).status, 404, 'no other files of the card folder');
  assert.equal((await call('GET', `/api/cards/${card.id}/attachments/..%2Fcard.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/cards/${card.id}/attachments`)).status, 401, 'needs the token');
});

test('the refiner is pointed at the images and may read them', async () => {
  const card = (await call('POST', '/api/cards', { title: 'Katso kuvaa', repos: ['repo-a'] })).body;
  const { name } = (await call('POST', `/api/cards/${card.id}/attachments`, PNG, 'image/png')).body;
  assert.equal((await call('POST', `/api/cards/${card.id}/refine/start`, {})).status, 202);
  await server.refiner.settled();
  const run = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  const addDirs = run.args.flatMap((a, i) => (a === '--add-dir' ? [run.args[i + 1]] : []));
  assert.ok(addDirs.some((d) => d.endsWith(join(card.id, 'attachments'))), 'the attachments folder is readable');
  assert.match(run.prompt, /## Attached images/);
  assert.ok(run.prompt.includes(name));
});

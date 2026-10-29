import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';
import { createJournal } from '../lib/events.js';

const fake = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const headers = { Cookie: 'ac_token=t', 'Content-Type': 'application/json' };
let dir, data;

async function start() {
  const server = createApp({ dataDir: data, token: 't', reposRoot: join(dir, 'repos'), claude: createClaude({ command: process.execPath, prefixArgs: [fake] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { server, base, call, close: () => new Promise((r) => server.close(r)) };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-events-'));
  data = join(dir, 'data');
  await mkdir(join(dir, 'repos', 'repo-a'), { recursive: true });
  process.env.FAKE_LOG = join(dir, 'fake.log');
});
after(() => rm(dir, { recursive: true, force: true }));

test('the event log and the conversation survive a restart', async () => {
  const first = await start();
  const card = (await first.call('POST', '/api/cards', { title: 'Lokitettava', repos: ['repo-a'] })).body;
  await first.call('PATCH', `/api/cards/${card.id}`, { status: 'archive' });
  await first.call('POST', '/api/chat', { who: 'me', text: 'perusta projekti' });
  await first.call('POST', '/api/chat', { who: 'bot', text: 'Mikä nimeksi?' });
  await first.server.journal.flushed();
  await first.close();

  const second = await start(); // same data folder: what a restart sees
  const events = (await second.call('GET', '/api/events')).body;
  assert.deepEqual(events.map((e) => [e.kind, e.text, e.card]), [
    ['card', 'Uusi kortti: Lokitettava (repo-a)', card.id],
    ['card', 'Lokitettava: Inbox → Archive', card.id],
  ]);
  assert.ok(events.every((e) => !Number.isNaN(Date.parse(e.t))));
  assert.deepEqual((await second.call('GET', '/api/chat')).body.map((m) => [m.who, m.text]), [['me', 'perusta projekti'], ['bot', 'Mikä nimeksi?']]);
  assert.equal((await second.call('POST', '/api/chat', { who: 'robot', text: 'x' })).status, 400);
  assert.equal((await second.call('POST', '/api/chat', { who: 'me', text: '  ' })).status, 400);
  assert.equal((await second.call('GET', '/api/events?limit=1')).body.length, 1);
  await second.close();
});

test('the stream sends the backlog, then new events as they happen', async () => {
  const app = await start();
  const lines = [];
  const req = request(`${app.base}/api/events/stream?limit=2`, { headers: { Cookie: 'ac_token=t' } });
  const got = new Promise((resolve) => {
    req.on('response', (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        for (const m of buf.split('\n\n').slice(0, -1)) if (m.startsWith('data: ')) lines.push(JSON.parse(m.slice(6)));
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
        if (lines.some((l) => l.text === 'Uusi kortti: Livenä')) resolve();
      });
    });
  });
  req.end();
  await new Promise((r) => setTimeout(r, 200));
  await app.call('POST', '/api/cards', { title: 'Livenä' });
  await got;
  req.destroy();
  assert.equal(lines.length, 3, 'two from the backlog, one live');
  assert.equal(lines[0].text, 'Uusi kortti: Lokitettava (repo-a)');
  await app.close();
});

test('the journal rotates a big file and still reads its tail across both', async () => {
  const file = join(dir, 'rot', 'events.jsonl');
  const j = createJournal(file, { maxBytes: 300 });
  for (let i = 0; i < 12; i++) j.add({ kind: 'app', text: `rivi ${i}` });
  await j.flushed();
  assert.ok(existsSync(join(dir, 'rot', 'events.1.jsonl')), 'rotated');
  assert.ok(readFileSync(file, 'utf8').length < 600);
  const tail = await j.tail(5);
  assert.deepEqual(tail.map((e) => e.text), ['rivi 7', 'rivi 8', 'rivi 9', 'rivi 10', 'rivi 11']);
  const seen = [];
  const off = j.subscribe((e) => seen.push(e.text));
  j.add({ kind: 'app', text: 'live' });
  off();
  j.add({ kind: 'app', text: 'not seen' });
  assert.deepEqual(seen, ['live']);
});

import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createCardStore } from '../lib/cards.js';
import { createTranscriptReader, createUsageLedger, projectDirName, totalTokens, usageFromResult } from '../lib/usage.js';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'ac-usage-')); });
after(() => rm(dir, { recursive: true, force: true }));

const msg = (id, u) => `${JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } } })}\n`;

describe('transcript reader', () => {
  test('counts each message once, reads only what was appended, and waits for a half-written line', async () => {
    const claudeDir = join(dir, 'claude');
    const cwd = join(dir, 'wt');
    const sessionDir = join(claudeDir, 'projects', projectDirName(cwd));
    await mkdir(sessionDir, { recursive: true });
    const file = join(sessionDir, 's1.jsonl');
    const cardDir = join(dir, 'card');
    await mkdir(cardDir);
    const reader = createTranscriptReader({ claudeDir });

    // The same reply appears on two lines (thinking, then the tool call) with the same counts.
    await writeFile(file, msg('m1', [2, 80, 0, 7000]) + msg('m1', [2, 83, 0, 7000]) + '{"type":"user"}\n');
    assert.deepEqual(await reader.collect(cardDir, { sessionId: 's1', cwd }), { input: 2, output: 83, cacheRead: 0, cacheWrite: 7000 });

    // Nothing new: nothing added.
    assert.deepEqual(await reader.collect(cardDir, { sessionId: 's1', cwd }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    // A new reply, and the start of another that is not finished yet.
    appendFileSync(file, msg('m2', [1, 10, 7000, 50]));
    appendFileSync(file, msg('m3', [1, 5, 0, 0]).slice(0, 40));
    assert.deepEqual(await reader.collect(cardDir, { sessionId: 's1', cwd }), { input: 1, output: 10, cacheRead: 7000, cacheWrite: 50 });

    // The line is completed later and counted then.
    appendFileSync(file, msg('m3', [1, 5, 0, 0]).slice(40));
    assert.deepEqual(await reader.collect(cardDir, { sessionId: 's1', cwd }), { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 });
  });

  test('a resumed session that carries earlier messages along does not count them twice', async () => {
    const claudeDir = join(dir, 'claude2');
    const sessionDir = join(claudeDir, 'projects', 'somewhere');
    await mkdir(sessionDir, { recursive: true });
    const cardDir = join(dir, 'card2');
    await mkdir(cardDir);
    await writeFile(join(sessionDir, 'a.jsonl'), msg('m1', [5, 50, 0, 0]));
    await writeFile(join(sessionDir, 'b.jsonl'), msg('m1', [5, 50, 0, 0]) + msg('m2', [3, 30, 0, 0]));
    const reader = createTranscriptReader({ claudeDir, scanEveryMs: 0 });
    // The folder name is not the one derived from cwd, so the session is searched for.
    assert.equal(totalTokens(await reader.collect(cardDir, { sessionId: 'a', cwd: join(dir, 'nowhere') })), 55);
    assert.equal(totalTokens(await reader.collect(cardDir, { sessionId: 'b', cwd: join(dir, 'nowhere') })), 33);
  });

  test('a missing transcript is not an error', async () => {
    const cardDir = join(dir, 'card3');
    await mkdir(cardDir);
    const reader = createTranscriptReader({ claudeDir: join(dir, 'empty') });
    assert.equal(totalTokens(await reader.collect(cardDir, { sessionId: 'nope', cwd: dir })), 0);
  });
});

describe('ledger', () => {
  test('sums per kind, card, project and local day; empty spends are not written', async () => {
    const data = join(dir, 'ledger');
    const ledger = createUsageLedger(data, { now: () => new Date(2026, 9, 27, 12) });
    ledger.record('agent', { input: 10, output: 20, cacheRead: 100, cacheWrite: 5 }, { card: 'c-1' });
    ledger.record('review', { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, { card: 'c-1' });
    ledger.record('planner', { input: 4, output: 4, cacheRead: 0, cacheWrite: 0 }, { project: 'demo' });
    ledger.record('agent', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { card: 'c-2' });
    const s = await ledger.summary();
    assert.deepEqual(s.total, { input: 15, output: 26, cacheRead: 100, cacheWrite: 5 });
    assert.deepEqual(s.byCard['c-1'], { input: 11, output: 22, cacheRead: 100, cacheWrite: 5 });
    assert.equal(s.byCard['c-2'], undefined);
    assert.equal(totalTokens(s.byProject.demo), 8);
    assert.equal(totalTokens(s.byKind.agent), 35);
    assert.equal(s.byDay.length, 1);
    assert.equal(s.byDay[0].day, '2026-10-27');
    assert.deepEqual(s.today, s.total);
  });

  test('reads usage out of a result event', () => {
    assert.deepEqual(usageFromResult({ usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } }), { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 });
    assert.deepEqual(usageFromResult({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('card cache', () => {
  test('sees a changed card and hands out copies', async () => {
    const store = createCardStore(join(dir, 'cache'));
    const card = await store.create({ title: 'One' });
    const a = await store.get(card.id);
    a.title = 'mutated by a caller';
    assert.equal((await store.get(card.id)).title, 'One');
    await store.update(card.id, { title: 'Two' });
    assert.equal((await store.get(card.id)).title, 'Two');
    assert.equal((await store.list())[0].title, 'Two');
  });
});

describe('one-time sign-in', () => {
  test('a login code works once, an unknown one never, and the token still works', async () => {
    const server = createApp({ dataDir: join(dir, 'login'), token: 'tok' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const code = server.newLoginCode();
      const first = await fetch(`${base}/?login=${code}`, { redirect: 'manual' });
      assert.equal(first.status, 302);
      assert.match(first.headers.get('set-cookie'), /ac_token=tok; HttpOnly/);
      assert.equal((await fetch(`${base}/?login=${code}`, { redirect: 'manual' })).status, 401);
      assert.equal((await fetch(`${base}/?login=nope`, { redirect: 'manual' })).status, 401);
      assert.equal((await fetch(`${base}/?token=tok`, { redirect: 'manual' })).status, 302);
      const usage = await fetch(`${base}/api/usage`, { headers: { Cookie: 'ac_token=tok' } });
      assert.equal(usage.status, 200);
      assert.deepEqual((await usage.json()).total, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

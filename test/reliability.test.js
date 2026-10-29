import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createCardStore } from '../lib/cards.js';
import { appendRotating, createJournal } from '../lib/events.js';
import { createWorktree } from '../lib/git.js';
import { LockedError, acquireLock } from '../lib/lock.js';
import { createRetention } from '../lib/retention.js';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'agentcontrol-reliability-')); });
after(() => rm(dir, { recursive: true, force: true }));

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

test('a second instance is refused while the first lives, and a stale lock is taken over', () => {
  const file = join(dir, 'lock', 'a.lock');
  const release = acquireLock(file, { pid: 111, isAlive: () => true });
  assert.throws(() => acquireLock(file, { pid: 222, isAlive: (p) => p === 111 }), LockedError);
  release();
  assert.equal(existsSync(file), false);

  writeFileSync(file, '333'); // left by a process that is gone
  const again = acquireLock(file, { pid: 444, isAlive: () => false });
  assert.equal(readFileSync(file, 'utf8'), '444');
  again();
  assert.equal(existsSync(file), false);
});

test('release does not remove a lock that now belongs to someone else', () => {
  const file = join(dir, 'b.lock');
  const release = acquireLock(file, { pid: 1 });
  writeFileSync(file, '2');
  release();
  assert.equal(readFileSync(file, 'utf8'), '2');
});

test('a repeating error is logged once and then counted', async () => {
  const file = join(dir, 'events.jsonl');
  const journal = createJournal(file, { collapseMs: 60_000 });
  for (let i = 0; i < 5; i++) journal.add({ kind: 'error', level: 'error', text: 'runner tick: claude agents failed' });
  journal.add({ kind: 'app', text: 'something else' });
  const lines = await journal.tail();
  assert.deepEqual(lines.map((l) => l.text), ['runner tick: claude agents failed', 'runner tick: claude agents failed (toistui 4 kertaa)', 'something else']);
});

test('without collapseMs every entry is written', async () => {
  const journal = createJournal(join(dir, 'plain.jsonl'));
  for (let i = 0; i < 3; i++) journal.add({ kind: 'error', level: 'error', text: 'same' });
  assert.equal((await journal.tail()).length, 3);
});

test('appendRotating moves a full file aside', async () => {
  const file = join(dir, 'live.jsonl');
  await appendRotating(file, 'x'.repeat(50) + '\n', 40);
  await appendRotating(file, 'second\n', 40);
  assert.equal(readFileSync(file, 'utf8'), 'second\n');
  assert.equal(readFileSync(join(dir, 'live.1.jsonl'), 'utf8').length, 51);
});

test('only archived cards past the retention time lose their live stream', async () => {
  const data = join(dir, 'retention');
  const store = createCardStore(data);
  const old = await store.create({ title: 'old' });
  const fresh = await store.create({ title: 'fresh' });
  const active = await store.create({ title: 'active' });
  for (const c of [old, fresh, active]) writeFileSync(join(store.dir(c.id), 'live.jsonl'), '{}\n');
  await store.update(old.id, { status: 'archive' });
  await store.update(fresh.id, { status: 'archive' });
  const file = join(store.dir(old.id), 'card.json'); // archived 40 days ago
  const card = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...card, updatedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }));
  assert.deepEqual(await createRetention({ store, days: 30 }).sweep(), { cards: 1 });
  assert.equal(existsSync(join(store.dir(old.id), 'live.jsonl')), false);
  assert.equal(existsSync(file), true);
  assert.equal(existsSync(join(store.dir(fresh.id), 'live.jsonl')), true); // archived recently
  assert.equal(existsSync(join(store.dir(active.id), 'live.jsonl')), true); // not archived
});

test('days = 0 keeps everything', async () => {
  const store = createCardStore(join(dir, 'retention-off'));
  const c = await store.create({ title: 'x' });
  writeFileSync(join(store.dir(c.id), 'live.jsonl'), '{}\n');
  await store.update(c.id, { status: 'archive' });
  await createRetention({ store, days: 0, now: () => Date.now() + 1e12 }).sweep();
  assert.equal(existsSync(join(store.dir(c.id), 'live.jsonl')), true);
});

test('an existing worktree folder is reused only when it is that card\'s worktree', async () => {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);

  const path = join(dir, 'wt', 'c-1', 'repo');
  const first = await createWorktree({ repoPath: repo, path, branch: 'ac/c-1-x' });
  assert.equal(first.reused, false);
  writeFileSync(join(path, 'wip.txt'), 'unfinished'); // dirty is fine
  assert.equal((await createWorktree({ repoPath: repo, path, branch: 'ac/c-1-x' })).reused, true);

  // same folder, other branch expected
  await assert.rejects(createWorktree({ repoPath: repo, path, branch: 'ac/c-1-other' }), /cannot be reused.*not ac\/c-1-other/);

  // leftover empty folder: not a worktree
  const empty = join(dir, 'wt', 'c-2', 'repo');
  mkdirSync(empty, { recursive: true });
  await assert.rejects(createWorktree({ repoPath: repo, path: empty, branch: 'ac/c-2-x' }), /cannot be reused/);
});

test('a worktree folder deleted by hand can be created again', async () => {
  const repo = join(dir, 'repo2');
  mkdirSync(repo, { recursive: true });
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
  const path = join(dir, 'wt2', 'repo');
  await createWorktree({ repoPath: repo, path, branch: 'ac/c-3-x' });
  await rm(path, { recursive: true, force: true });
  assert.equal((await createWorktree({ repoPath: repo, path, branch: 'ac/c-3-x' })).reused, false);
});

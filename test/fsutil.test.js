import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readJson, writeJsonAtomic } from '../lib/fsutil.js';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'agentcontrol-fsutil-')); });
after(() => rm(dir, { recursive: true, force: true }));

describe('writeJsonAtomic', () => {
  test('replaces the file and leaves no temp file behind', async () => {
    const file = join(dir, 'a', 'x.json');
    await writeJsonAtomic(file, { n: 1 });
    await writeJsonAtomic(file, { n: 2 });
    assert.deepEqual(await readJson(file), { n: 2 });
    assert.equal(await readFile(`${file}.tmp`, 'utf8').catch((e) => e.code), 'ENOENT');
  });

  // On Windows a rename onto a file that a reader has open fails with EPERM, and the page polls these files all the time.
  test('waits out a reader that has the file open for a moment', async () => {
    const file = join(dir, 'polled.json');
    await writeJsonAtomic(file, { n: 1 });
    const reader = await open(file, 'r');
    const released = new Promise((resolve) => setTimeout(() => reader.close().then(resolve), 60));
    await writeJsonAtomic(file, { n: 2 });
    await released;
    assert.deepEqual(await readJson(file), { n: 2 });
  });
});

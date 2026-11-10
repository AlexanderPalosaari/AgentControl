import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, runSerial } from '../lib/serial.js';

const SCRIPT = fileURLToPath(new URL('../scripts/serial.js', import.meta.url));

test('two holders of the same lock never overlap; different names do not wait', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-serial-'));
  try {
    const events = [];
    const hold = async (who, name) => {
      const lock = await acquire(name, { dir, pollMs: 20 });
      events.push(`${who}+`);
      await new Promise((r) => setTimeout(r, 150));
      events.push(`${who}-`);
      await lock.release();
    };
    await Promise.all([hold('a', 'db'), hold('b', 'db')]);
    assert.ok(['a+,a-,b+,b-', 'b+,b-,a+,a-'].includes(events.join(',')), events.join(','));

    events.length = 0;
    await Promise.all([hold('a', 'db'), hold('c', 'other')]);
    assert.equal(events.slice(0, 2).sort().join(','), 'a+,c+');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock left by processes that are gone is taken over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-serial-'));
  try {
    await mkdir(join(dir, 'db'));
    await writeFile(join(dir, 'db', 'owner.json'), JSON.stringify({ pid: 999999, childPid: 999998, since: 'x' }));
    const lock = await acquire('db', { dir, pollMs: 20 });
    assert.equal(JSON.parse(await readFile(join(dir, 'db', 'owner.json'), 'utf8')).pid, process.pid);
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runSerial runs the command, passes its exit code and frees the lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-serial-'));
  try {
    const code = await runSerial('db', [process.execPath, '-e', 'process.exit(3)'], { dir, log: () => {} });
    assert.equal(code, 3);
    const lock = await acquire('db', { dir, pollMs: 20 }); // free again
    await lock.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the command-line script refuses a call without a command', async () => {
  const code = await new Promise((resolve) => spawn(process.execPath, [SCRIPT, 'db'], { stdio: 'ignore' }).on('exit', resolve));
  assert.equal(code, 2);
});

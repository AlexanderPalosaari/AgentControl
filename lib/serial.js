import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A machine-wide lock by name: commands that use one shared resource (a test database the code fixes, a port)
 * run one at a time, across every agent on this machine. The lock is a folder (mkdir is atomic) holding the
 * owner's pids; a lock whose processes are all gone is stale and taken over.
 */
export const DEFAULT_LOCKS_DIR = join(tmpdir(), 'agentcontrol-locks');
const NO_OWNER_GRACE_MS = 10_000; // a lock folder without owner.json: the owner may be writing it right now

const safeName = (name) => String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const readOwner = (dir) => readFile(join(dir, 'owner.json'), 'utf8').then(JSON.parse, () => null);
const sameOwner = (a, b) => a && b && a.pid === b.pid && a.since === b.since;

async function isStale(dir, owner) {
  if (owner) return ![owner.pid, owner.childPid].some(alive);
  const s = await stat(dir).catch(() => null);
  return !s || Date.now() - s.mtimeMs > NO_OWNER_GRACE_MS;
}

/** Moves a stale lock out of the way, but only the one judged stale: a fresh owner that took it meanwhile stays. */
async function breakStale(dir, owner) {
  const aside = `${dir}.stale-${process.pid}-${Date.now()}`;
  if (!(await rename(dir, aside).then(() => true, () => false))) return;
  const moved = await readOwner(aside);
  if (owner && moved && !sameOwner(owner, moved)) {
    await rename(aside, dir).catch(() => {}); // took a fresh lock by mistake: put it back
    return;
  }
  await rm(aside, { recursive: true, force: true });
}

/**
 * Waits until the lock is free and takes it. `onWait(owner)` is called when it has to wait, then about once a minute.
 * Returns { setChild(pid), release() }.
 */
export async function acquire(name, { dir: locksDir = DEFAULT_LOCKS_DIR, label = process.cwd(), pollMs = 2000, onWait = () => {} } = {}) {
  await mkdir(locksDir, { recursive: true });
  const dir = join(locksDir, safeName(name));
  const me = { pid: process.pid, childPid: null, label, since: new Date().toISOString() };
  let lastNote = 0;
  for (;;) {
    const took = await mkdir(dir).then(() => true, (e) => { if (e.code === 'EEXIST') return false; throw e; });
    if (took) {
      await writeFile(join(dir, 'owner.json'), JSON.stringify(me), 'utf8');
      return {
        async setChild(pid) { me.childPid = pid; await writeFile(join(dir, 'owner.json'), JSON.stringify(me), 'utf8').catch(() => {}); },
        async release() { if (sameOwner(me, await readOwner(dir))) await rm(dir, { recursive: true, force: true }); },
      };
    }
    const owner = await readOwner(dir);
    if (await isStale(dir, owner)) { await breakStale(dir, owner); continue; }
    if (Date.now() - lastNote >= 60_000) { lastNote = Date.now(); onWait(owner); }
    await sleep(pollMs);
  }
}

/** Quotes one argument for cmd.exe when the command runs through the Windows shell (npm, npx are .cmd files). */
const winQuote = (a) => (/^[\w./:=\\~-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** Runs `argv` while holding the lock `name`; resolves with its exit code. */
export async function runSerial(name, argv, { log = (m) => process.stderr.write(`${m}\n`), ...opts } = {}) {
  if (!argv.length) throw new Error('Give the command to run after --');
  const lock = await acquire(name, {
    ...opts,
    onWait: (o) => log(`[serial] Waiting for "${name}": in use by ${o?.label ?? 'another run'}${o?.since ? ` since ${o.since}` : ''}...`),
  });
  log(`[serial] Got "${name}", running: ${argv.join(' ')}`);
  const win = process.platform === 'win32';
  const child = win
    ? spawn(argv.map(winQuote).join(' '), { stdio: 'inherit', shell: true })
    : spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
  await lock.setChild(child.pid);
  const stop = () => killTree(child);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await new Promise((resolve) => {
      child.on('error', (e) => { log(`[serial] ${e.message}`); resolve(127); });
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await lock.release();
  }
}

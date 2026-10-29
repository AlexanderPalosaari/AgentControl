import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Exit code of `node server.js` when another instance holds the lock; the watchdog does not restart on it. */
export const EXIT_LOCKED = 75;

export class LockedError extends Error {
  constructor(pid, file) {
    super(`AgentControl is already running (pid ${pid}, lock ${file})`);
    this.pid = pid;
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * One AgentControl per data folder: two would dispatch the same cards twice. The lock is a file holding the pid,
 * created exclusively; a file left by a process that no longer exists (crash, power loss) is taken over.
 * Returns `release()`, which only removes the file while it is still ours.
 */
export function acquireLock(file, { pid = process.pid, isAlive = alive } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: 'wx' });
      return () => {
        try { if (readFileSync(file, 'utf8').trim() === String(pid)) rmSync(file); } catch { /* already gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const holder = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    if (holder === pid) return () => rmSync(file, { force: true }); // our own earlier lock
    if (Number.isInteger(holder) && isAlive(holder)) throw new LockedError(holder, file);
    rmSync(file, { force: true }); // stale: try to take it
  }
  throw new LockedError('unknown', file);
}

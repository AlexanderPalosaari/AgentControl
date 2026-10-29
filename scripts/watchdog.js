// Keeps server.js running: restarts it after a crash, waiting longer after each quick failure (2 s, 4 s ... 60 s;
// the wait resets once a run has lasted a minute). Stops when the server says another instance holds the lock
// (exit 75), when it exits cleanly (0), or when the watchdog itself is stopped.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_LOCKED } from '../lib/lock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logFile = join(process.env.AGENTCONTROL_DATA ?? join(root, 'data'), 'watchdog.log');
const STABLE_MS = 60_000;

const log = (text) => {
  const line = `${new Date().toISOString()} ${text}`;
  console.log(line);
  try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, `${line}\n`); } catch { /* the log is a convenience */ }
};

let child = null;
let stopping = false;
let delay = 2_000;

function run() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [join(root, 'server.js')], { cwd: root, windowsHide: true, stdio: 'inherit' });
  log(`server started (pid ${child.pid})`);
  child.on('error', (e) => log(`could not start the server: ${e.message}`));
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (code === EXIT_LOCKED) { log('another AgentControl holds the lock; watchdog stops'); return process.exit(0); }
    if (code === 0) { log('server exited cleanly; watchdog stops'); return process.exit(0); }
    delay = Date.now() - startedAt >= STABLE_MS ? 2_000 : Math.min(delay * 2, 60_000);
    log(`server ended (${signal ?? `code ${code}`}); restarting in ${delay / 1000} s`);
    setTimeout(run, delay);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; if (child) child.kill(); else process.exit(0); });
}
run();

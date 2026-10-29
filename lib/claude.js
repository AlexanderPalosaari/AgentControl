import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Finds the real claude executable. Spawning without a shell cannot run the npm
 * `claude.cmd` shim, so look for claude.exe on PATH, or read it out of the shim.
 * AGENTCONTROL_CLAUDE overrides everything.
 */
export function resolveClaudeExecutable(env = process.env) {
  if (env.AGENTCONTROL_CLAUDE) return env.AGENTCONTROL_CLAUDE;
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const exe = join(dir, 'claude.exe');
    if (existsSync(exe)) return exe;
  }
  for (const dir of dirs) {
    const shim = join(dir, 'claude.cmd');
    if (!existsSync(shim)) continue;
    const m = readFileSync(shim, 'utf8').match(/"%dp0%\\([^"]+claude\.exe)"/i);
    if (m) {
      const exe = resolve(dirname(shim), m[1]);
      if (existsSync(exe)) return exe;
    }
  }
  return 'claude';
}

/**
 * Runs the claude CLI headless (`-p`), feeding the prompt on stdin and streaming
 * stream-json events to onEvent. Resolves with the final `result` event.
 * Retries only when the process fails to start (Claude Code's auto-update briefly
 * locks or removes the executable).
 */
export function createClaude({ command = resolveClaudeExecutable(), prefixArgs = [], retries = 4, retryDelayMs = 1500 } = {}) {
  function runOnce({ args, cwd, prompt, onEvent, signal }) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...prefixArgs, ...args], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let result = null;
      let buf = '';
      let stderr = '';
      let settled = false;

      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      const onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (e) => fail(Object.assign(e, { startFailure: true })));
      child.stdin.on('error', () => {}); // EPIPE if the process dies early; close handler reports it
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handleLine(line);
        }
      });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (buf.trim()) handleLine(buf.trim());
        if (settled) return;
        settled = true;
        if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { aborted: true }));
        if (result) return resolvePromise(result);
        reject(new Error(`claude exited with code ${code} without a result. ${stderr.trim()}`));
      });

      function handleLine(line) {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'result') result = event;
        try { onEvent?.(event); } catch (e) { console.error('onEvent failed:', e.message); }
      }

      child.stdin.end(prompt);
    });
  }

  /**
   * Runs a plain subcommand (`agents`, `stop`, `--bg ...`) and collects its output.
   * `claude --bg` can leave a background service holding the pipes open, so we stop
   * waiting shortly after the process exits instead of waiting for the pipes to close.
   */
  function execOnce({ args, cwd, timeoutMs = 60_000 }) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...prefixArgs, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
      const timer = setTimeout(() => { child.kill(); finish(reject, new Error(`claude ${args[0]} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      child.on('error', (e) => finish(reject, Object.assign(e, { startFailure: true })));
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('exit', (code) => setTimeout(() => finish(resolvePromise, { code, stdout, stderr }), 300));
    });
  }

  const withRetry = async (fn, opts) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(opts);
      } catch (e) {
        if (!e.startFailure || attempt >= retries) throw e;
        await sleep(retryDelayMs * attempt);
      }
    }
  };

  return { command, prefixArgs, run: (opts) => withRetry(runOnce, opts), exec: (args, opts = {}) => withRetry(execOnce, { ...opts, args }) };
}

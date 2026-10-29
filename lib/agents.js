import { spawn } from 'node:child_process';

/**
 * Thin wrapper over `claude --bg`, `claude agents --json`, `claude stop`.
 *
 * Facts learned from the CLI (v2.1.266):
 *  - `claude --bg "<prompt>" [flags]` prints "backgrounded · <id>"; the prompt must come
 *    first because --allowedTools/--add-dir are variadic and would swallow it.
 *  - `claude agents --json --all` lists interactive sessions too: filter kind === 'background'.
 *  - A job reads `busy/working` while running, `idle/done` when its turn is over (the process
 *    stays alive) and `waiting/blocked` + `waitingFor` on a permission prompt.
 *  - `--bg --resume <session>` with NO flags wakes that job under the same id with its saved
 *    options. With flags, or while the job is still alive, it starts a copy under a new id.
 *    So: stop first, then wake without flags.
 */
export function createAgents({ claude }) {
  const parseId = (r, what) => {
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    const m = r.stdout.match(/backgrounded\W+([0-9a-f]{6,})/i);
    if (!m) throw new Error(`${what}: could not find the agent id in: ${r.stdout.trim().slice(0, 300)}`);
    return m[1];
  };

  async function start({ cwd, message, model, effort, addDirs = [], allowedTools = [], disallowedTools = [], permissionMode = 'acceptEdits' }) {
    const args = ['--bg', message, '--permission-mode', permissionMode];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
    if (disallowedTools.length) args.push('--disallowedTools', ...disallowedTools);
    for (const dir of addDirs) args.push('--add-dir', dir);
    return parseId(await claude.exec(args, { cwd }), 'claude --bg');
  }

  /** Continues a stopped session under a new id with these options (flags make --resume start a copy). */
  async function resume({ cwd, sessionId, message, model, effort, addDirs = [], allowedTools = [], disallowedTools = [], permissionMode }) {
    const args = ['--bg', '--resume', sessionId, message, '--permission-mode', permissionMode];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
    if (disallowedTools.length) args.push('--disallowedTools', ...disallowedTools);
    for (const dir of addDirs) args.push('--add-dir', dir);
    return parseId(await claude.exec(args, { cwd }), 'claude --bg --resume');
  }

  async function wake({ cwd, sessionId, message }) {
    return parseId(await claude.exec(['--bg', '--resume', sessionId, message], { cwd }), 'claude --bg --resume');
  }

  async function list() {
    const r = await claude.exec(['agents', '--json', '--all']);
    if (r.code !== 0) throw new Error(`claude agents failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    const json = r.stdout.slice(r.stdout.indexOf('['));
    return JSON.parse(json).filter((a) => a.kind === 'background');
  }

  async function stop(id) {
    const r = await claude.exec(['stop', id]);
    return r.code === 0;
  }

  /**
   * Opens `claude attach <id>` in a new console window on the person's desktop: the only place a background
   * agent's permission prompt can be answered. `openWindow` is replaceable for tests.
   */
  async function attachInWindow(id, { openWindow = openConsole } = {}) {
    if (!/^[0-9a-f]{6,}$/i.test(id)) throw new Error(`Invalid agent id: ${id}`);
    await openWindow([claude.command, ...(claude.prefixArgs ?? []), 'attach', id], `AgentControl ${id}`);
    return { opened: true };
  }

  return { start, resume, wake, list, stop, attachInWindow };
}

function openConsole(argv, title) {
  if (process.platform !== 'win32') throw Object.assign(new Error(`Open a terminal and run: ${argv.join(' ')}`), { expose: true });
  // `start` opens a new console window; its first quoted argument is the window title. Built by hand because
  // cmd.exe has its own quoting rules; every part is a known path, a fixed word or a validated id.
  const quote = (s) => `"${String(s).replaceAll('"', '')}"`;
  const line = `/d /s /c "start ${quote(title)} ${argv.map(quote).join(' ')}"`;
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', [line], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.on('error', reject);
    child.on('spawn', () => { child.unref(); resolve(); });
  });
}

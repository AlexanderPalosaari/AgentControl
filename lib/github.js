import { spawn } from 'node:child_process';

const API = 'https://api.github.com';

/**
 * Gets a GitHub token without AgentControl storing one: AGENTCONTROL_GITHUB_TOKEN or GITHUB_TOKEN, else the
 * GitHub CLI (`gh auth token`), else what Git Credential Manager holds for github.com (the login `git push` uses).
 * Asked again on every call: creating a repository is rare, and a revoked token then needs no restart.
 */
export function createGithubToken({ env = process.env, run = runCommand } = {}) {
  return async function getToken() {
    const fromEnv = (env.AGENTCONTROL_GITHUB_TOKEN || env.GITHUB_TOKEN || '').trim();
    if (fromEnv) return fromEnv;
    try {
      const token = (await run('gh', ['auth', 'token'])).trim();
      if (token) return token;
    } catch { /* no gh, or not logged in */ }
    try {
      const out = await run('git', ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n');
      const token = out.match(/^password=(.+)$/m)?.[1]?.trim();
      if (token) return token;
    } catch { /* nothing stored for github.com */ }
    throw Object.assign(new Error('No GitHub login found. Run "gh auth login", or push once to github.com so Git Credential Manager remembers you, or set AGENTCONTROL_GITHUB_TOKEN.'), { expose: true });
  };
}

/** Runs a command without a shell. Credential prompts are off: a server must not wait for a window nobody sees. */
function runCommand(cmd, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} timed out`)); }, 30_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited with ${code}`)); });
    child.stdin.end(input);
  });
}

export class GithubError extends Error {
  constructor(message, status) { super(message); this.status = status; this.expose = true; }
}

export function createGithub({ getToken, fetchImpl = fetch, apiBase = API }) {
  async function request(method, path, body) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await getToken()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AgentControl', ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const detail = [json?.message, ...(json?.errors ?? []).map((e) => e.message ?? e.code)].filter(Boolean).map((s) => String(s).replace(/\.$/, '')).join(': ');
      throw new GithubError(`GitHub ${method} ${path} failed (${res.status}): ${detail || text.slice(0, 200)}`, res.status);
    }
    return json;
  }

  return {
    /** Creates an empty repository for the signed-in user, or in `owner` when that names an organization. */
    async createRepo({ owner = null, name, description = '', private: isPrivate = true }) {
      let path = '/user/repos';
      if (owner && (await request('GET', '/user')).login.toLowerCase() !== owner.toLowerCase()) path = `/orgs/${encodeURIComponent(owner)}/repos`;
      const repo = await request('POST', path, { name, description, private: isPrivate, auto_init: false });
      return { fullName: repo.full_name, url: repo.html_url, cloneUrl: repo.clone_url, private: repo.private };
    },
  };
}

import { spawn } from 'node:child_process';

const API_VERSION = '7.1';
const AZDO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'; // Azure DevOps' application id for `az account get-access-token`

/**
 * Splits an Azure DevOps git remote URL into what the REST API needs.
 * Handles dev.azure.com (https, with or without user@), ssh.dev.azure.com and the older *.visualstudio.com.
 * Returns null for anything else.
 */
export function parseRemote(url) {
  const u = String(url).trim();
  const dec = decodeURIComponent;
  let m = u.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { baseUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = u.match(/^https:\/\/([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { baseUrl: `https://${m[1]}.visualstudio.com`, project: dec(m[2]), repo: dec(m[3]) };
  m = u.match(/^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com[:/](?:\d+\/)?v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
  if (m) return { baseUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  return null;
}

/**
 * Gets a bearer token for Azure DevOps from the Azure CLI session (`az login`), cached until shortly before it expires.
 * `az` is a .cmd on Windows, which cannot be spawned directly, so it goes through cmd.exe with fixed arguments only.
 */
export function createAzCliToken({ run = runAz } = {}) {
  let cached = null;
  return async function getToken() {
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const out = await run(['account', 'get-access-token', '--resource', AZDO_RESOURCE, '--output', 'json']);
    const { accessToken, expiresOn } = JSON.parse(out);
    cached = { token: accessToken, expiresAt: Date.parse(expiresOn) || Date.now() + 30 * 60_000 };
    return cached.token;
  };
}

function runAz(args) {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'az', ...args]] : ['az', args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('az timed out')); }, 60_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const expose = (message) => Object.assign(new Error(message), { expose: true });
    child.on('error', (e) => { clearTimeout(timer); reject(expose(`Could not run the Azure CLI (az): ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(expose(`az failed. Run "az login" and try again. ${stderr.trim().split('\n').pop()}`));
    });
  });
}

export class AzdoError extends Error {
  constructor(message, status) { super(message); this.status = status; this.expose = true; }
}

export function createAzdo({ getToken, fetchImpl = fetch }) {
  async function request(remote, method, path, body) {
    const url = `${remote.baseUrl}/${encodeURIComponent(remote.project)}/_apis/git/repositories/${encodeURIComponent(remote.repo)}/${path}`
      + `${path.includes('?') ? '&' : '?'}api-version=${API_VERSION}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual', // a sign-in redirect means the token was not accepted; do not follow it to an HTML page
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.status >= 300 && res.status < 400) throw new AzdoError('Azure DevOps redirected to a sign-in page; the token was not accepted. Run "az login".', 401);
    if (!res.ok) throw new AzdoError(`Azure DevOps ${method} ${path.split('?')[0]} failed (${res.status}): ${json?.message ?? text.slice(0, 200)}`, res.status);
    return json;
  }

  const prUrl = (remote, id) => `${remote.baseUrl}/${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${id}`;
  const shape = (remote, pr) => ({ id: pr.pullRequestId, url: prUrl(remote, pr.pullRequestId), state: pr.status, mergeStatus: pr.mergeStatus ?? null });

  return {
    async createPr(remote, { source, target, title, description }) {
      const pr = await request(remote, 'POST', 'pullrequests', {
        sourceRefName: `refs/heads/${source}`, targetRefName: `refs/heads/${target}`, title, description,
      });
      return shape(remote, pr);
    },
    async getPr(remote, id) {
      return shape(remote, await request(remote, 'GET', `pullrequests/${id}`));
    },
    async findActivePr(remote, { source, target }) {
      const q = `searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${source}`)}&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${target}`)}&searchCriteria.status=active`;
      const list = await request(remote, 'GET', `pullrequests?${q}`);
      return list?.value?.[0] ? shape(remote, list.value[0]) : null;
    },
  };
}

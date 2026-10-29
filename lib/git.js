import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ValidationError } from './cards.js';

export function git(args, cwd, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(`git ${args.join(' ')}: ${(stderr || err.message).trim()}`), { code: err.code, expose: true }));
      resolve(stdout.trim());
    });
  });
}

const ok = (args, cwd) => git(args, cwd).then(() => true, () => false);

/** A path as git prints it (forward slashes) compared with one from node: same folder, case-insensitive on Windows. */
export const samePath = (a, b) => {
  const norm = (p) => realpathSync.native(p).replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** The ref new work should start from: origin's default branch if there is one, else a local branch. */
export async function baseRef(repoPath) {
  try {
    return await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath);
  } catch { /* no origin/HEAD */ }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await ok(['rev-parse', '--verify', '--quiet', candidate], repoPath)) return candidate;
  }
  return 'HEAD';
}

/**
 * Where a repository stands: its checked-out branch, how many commits it is ahead of and behind the base branch
 * (`baseRef`) and its own upstream, and how many files have uncommitted changes. Reads only local refs, so the
 * remote side is as of the last fetch. A count is null when it cannot be known (no base, no upstream, no commits).
 */
export async function branchStatus(repoPath) {
  const q = (args) => git(args, repoPath).catch(() => null);
  const counts = async (a, b) => {
    const out = await q(['rev-list', '--left-right', '--count', `${a}...${b}`]);
    return out ? out.split(/\s+/).map(Number) : [null, null];
  };
  const [branch, head, base, changes] = await Promise.all([
    q(['symbolic-ref', '--short', 'HEAD']), q(['rev-parse', '--short', 'HEAD']), baseRef(repoPath), q(['status', '--porcelain']),
  ]);
  const upstream = branch ? await q(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) : null;
  const [ahead, behind] = head && base !== 'HEAD' ? await counts('HEAD', base) : [null, null];
  const [toPush, toPull] = head && upstream ? await counts('HEAD', upstream) : [null, null];
  return {
    branch, head, base: base === 'HEAD' ? null : base, ahead, behind, upstream, toPush, toPull,
    changed: changes == null ? null : changes.split('\n').filter(Boolean).length,
  };
}

/**
 * The branches the repository's own folder can switch to: its local branches, and the remote ones (origin/x) that
 * have no local branch yet. A branch checked out in another worktree (a card's) is left out, since git refuses it.
 */
export async function switchableBranches(repoPath) {
  const [refs, worktrees] = await Promise.all([
    git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], repoPath).catch(() => ''),
    git(['worktree', 'list', '--porcelain'], repoPath).catch(() => ''),
  ]);
  const own = await git(['symbolic-ref', '--short', 'HEAD'], repoPath).catch(() => null);
  const elsewhere = new Set(worktrees.split('\n').filter((l) => l.startsWith('branch refs/heads/')).map((l) => l.slice('branch refs/heads/'.length)).filter((b) => b !== own));
  const lines = refs.split('\n').filter(Boolean);
  const local = lines.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length));
  const remote = lines.filter((r) => r.startsWith('refs/remotes/origin/') && r !== 'refs/remotes/origin/HEAD').map((r) => r.slice('refs/remotes/origin/'.length));
  return [...new Set([...local, ...remote])].filter((b) => !elsewhere.has(b) && !b.startsWith('-')).sort();
}

/**
 * Switches the repository's folder to `branch` (one of `switchableBranches`; a remote-only one gets a local branch
 * that tracks it), then brings it up to its upstream when that is only a fast-forward. Refused with uncommitted
 * changes, so nothing of the person's is carried over or lost. Returns { pulled } (commits brought in).
 */
export async function switchBranch(repoPath, branch) {
  if ((await git(['status', '--porcelain'], repoPath)).trim()) {
    throw new ValidationError('The repository has uncommitted changes. Commit or stash them first; nothing was switched.');
  }
  await git(['fetch', '--quiet', '--prune'], repoPath, { timeoutMs: 30_000 }).catch(() => {}); // offline or no remote: switch to what we have
  if (!(await switchableBranches(repoPath)).includes(branch)) throw new ValidationError(`No branch ${branch} to switch to (or a card's worktree has it checked out)`);
  await git(['switch', branch], repoPath);
  const behind = await git(['rev-list', '--count', 'HEAD..@{u}'], repoPath).then(Number, () => 0);
  if (!behind) return { pulled: 0 };
  const pulled = await git(['merge', '--ff-only', '--quiet', '@{u}'], repoPath).then(() => behind, () => 0); // diverged: left as it is, the status says so
  return { pulled };
}

/**
 * A folder that is already there is reused only if it is really this card's worktree: its own git root, on the
 * card's branch. Anything else (an empty leftover folder, a worktree of another branch) would make the agent work
 * in, and commit to, the wrong place. Uncommitted changes are fine: that is the agent's unfinished work.
 */
async function checkReusable({ repoPath, path, branch }) {
  const fail = (why) => Object.assign(new Error(`The worktree folder ${path} cannot be reused: ${why}. Remove it (or run git worktree remove) and start again.`), { expose: true });
  let top, head;
  try {
    top = await git(['rev-parse', '--show-toplevel'], path);
    head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], path);
  } catch {
    throw fail('it is not a git worktree');
  }
  if (!samePath(top, path)) throw fail('it is not the root of a git worktree');
  if (head !== branch) throw fail(`it is on ${head}, not ${branch}`);
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path).catch(() => null);
  const repoCommon = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath).catch(() => null);
  if (common && repoCommon && !samePath(common, repoCommon)) throw fail('it belongs to another repository');
}

/**
 * Creates (or reuses) a worktree for a card on its own branch, forked from the base
 * as it is on origin, not from a possibly diverged local branch.
 */
export async function createWorktree({ repoPath, path, branch }) {
  if (!existsSync(repoPath)) throw new Error(`Repository not found: ${repoPath}`);
  await git(['fetch', 'origin', '--quiet'], repoPath).catch(() => {}); // offline or no origin: fall back to what we have
  const base = await baseRef(repoPath);
  if (existsSync(path)) {
    await checkReusable({ repoPath, path, branch });
    return { path, branch, base, reused: true };
  }
  await mkdir(dirname(path), { recursive: true });
  await git(['worktree', 'prune'], repoPath).catch(() => {}); // a folder deleted by hand still counts as registered
  const branchExists = await ok(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath);
  await git(branchExists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base], repoPath);
  return { path, branch, base, reused: false };
}

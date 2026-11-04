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

// Git subcommands that only read. Those that also write (branch, tag, stash…) pass only in their listing forms.
const READ_COMMANDS = new Set(['log', 'show', 'diff', 'status', 'merge-base', 'reflog', 'rev-parse', 'rev-list', 'blame', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'cat-file', 'name-rev', 'for-each-ref', 'show-ref', 'grep', 'show-branch', 'cherry', 'range-diff', 'whatchanged', 'count-objects', 'branch', 'tag', 'stash', 'worktree', 'remote', 'config', 'ls-remote']);
// Anywhere: writing a file (--output), running a program (external diff, grep's pager) or reading outside the repository.
const NEVER = /^(--output|--ext-diff$|--open-files-in-pager|-O|--no-index$|--exec|--upload-pack|--receive-pack|--git-dir|--work-tree)/;
const LISTING = {
  branch: { writes: /^(-[dDmMcCfu]|--(delete|move|copy|force|set-upstream|unset-upstream|edit-description|track|no-track|create-reflog))/, lists: /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format)/ },
  tag: { writes: /^(-[dasfmFuev]|--(delete|annotate|sign|force|message|file|local-user|edit|create-reflog))/, lists: /^(-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format)/ },
};

/**
 * Checks that `args` (a git command line without the `git`) only reads the repository, or throws a ValidationError.
 * Used for the orchestrator's `git` tool: a read-only allowlist, not a sandbox, so anything unsure is refused.
 */
export function checkReadOnlyGit(args) {
  if (!Array.isArray(args) || !args.length || args.length > 60 || !args.every((a) => typeof a === 'string' && a.length <= 500 && !a.includes('\0'))) throw new ValidationError('args must be 1-60 strings, e.g. ["log", "--oneline", "-n", "20"]');
  const [cmd, ...rest] = args;
  if (!READ_COMMANDS.has(cmd)) throw new ValidationError(`git ${cmd} is not allowed: only reading commands (${[...READ_COMMANDS].join(', ')})`);
  const bad = rest.find((a) => NEVER.test(a));
  if (bad) throw new ValidationError(`git option ${bad} is not allowed`);
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (LISTING[cmd]) {
    const { writes, lists } = LISTING[cmd];
    const w = rest.find((a) => writes.test(a));
    if (w) throw new ValidationError(`git ${cmd} ${w} would change the repository`);
    if (positional.length && !rest.some((a) => lists.test(a))) throw new ValidationError(`git ${cmd} with a name creates one: add --list (or --contains/--merged) to list`);
  }
  const sub = positional[0];
  if (cmd === 'reflog' && ['expire', 'delete'].includes(sub)) throw new ValidationError(`git reflog ${sub} would change the repository`);
  if (cmd === 'stash' && !['list', 'show'].includes(sub)) throw new ValidationError('only git stash list / show');
  if (cmd === 'worktree' && sub !== 'list') throw new ValidationError('only git worktree list');
  if (cmd === 'remote' && sub && !['show', 'get-url'].includes(sub)) throw new ValidationError('only git remote, -v, show and get-url');
  if (cmd === 'config' && (!rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a)) || rest.some((a) => /^(--add|--unset|--replace-all|--rename-section|--remove-section|--edit|-e)/.test(a)))) throw new ValidationError('only git config --get / --get-all / --get-regexp / --list');
  return args;
}

/**
 * Runs a checked read-only git command in `cwd`: no optional locks (status does not touch the index), no fsmonitor
 * hook and no external diff program, output cut at `maxChars`.
 */
export async function readGit(args, cwd, { maxChars = 60_000 } = {}) {
  checkReadOnlyGit(args);
  const out = await git(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', ...args], cwd, { timeoutMs: 30_000 });
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n… (${out.length - maxChars} more characters; narrow the command, e.g. -n or a path)` : out;
}

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

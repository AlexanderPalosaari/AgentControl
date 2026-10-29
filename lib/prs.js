import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MergeConflictError, ValidationError } from './cards.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { git } from './git.js';
import { createRepos } from './repos.js';
import { parseRemote } from './azdo.js';

const MAX_DESCRIPTION = 3900; // Azure DevOps limits PR descriptions to 4000 characters

const defaultResolveRemote = async (worktreePath) => {
  const url = await git(['remote', 'get-url', 'origin'], worktreePath);
  const remote = parseRemote(url);
  if (!remote) throw new ValidationError(`origin is not an Azure DevOps repository: ${url.replace(/\/\/[^@/]+@/, '//')}`);
  return remote;
};

/**
 * Turns a finished card into pull requests (one per repo) and follows them until they are merged.
 * Pushing is the one outward-facing step, so it only ever happens when the person asks for it.
 */
export function createPublisher({ store, azdo, reposRoot, repos = createRepos({ reposRoot }), resolveRemote = defaultResolveRemote, pollMs = 30_000, log = () => {} }) {
  const locks = new Set();
  let lastPoll = 0;
  let timer = null;

  const prsFile = (id) => join(store.dir(id), 'prs.json');
  const load = (id) => readJson(prsFile(id), []);
  const target = (base) => base.replace(/^origin\//, '');

  async function describe(card, id) {
    const read = (name) => readFile(join(store.dir(id), name), 'utf8').catch(() => '');
    const [message, report] = await Promise.all([read('commit-message.txt'), read('report.md')]);
    const lines = message.trim().split('\n');
    const title = (lines[0] || card.title).slice(0, 200);
    const body = [lines.slice(1).join('\n').trim(), report.trim() && `## Agent report\n\n${report.trim()}`, `_Created by AgentControl from card ${card.id}._`]
      .filter(Boolean).join('\n\n');
    return { title, description: body.length > MAX_DESCRIPTION ? `${body.slice(0, MAX_DESCRIPTION)}\n\n_(truncated)_` : body };
  }

  /** Pushes each repo's branch and opens a pull request for it. Safe to repeat: finished repos are skipped. */
  async function publish(id) {
    if (locks.has(id)) throw new ValidationError('A publish is already in progress for this card');
    locks.add(id);
    try {
      const card = await store.get(id);
      if (card.status !== 'review') throw new ValidationError(`Only cards in review can be published (this one is ${card.status})`);
      const run = await readJson(join(store.dir(id), 'run.json'), null);
      if (!run?.worktrees?.length) throw new ValidationError('This card has no worktrees to publish');
      const { title, description } = await describe(card, id);
      const prs = await load(id);
      for (const wt of run.worktrees) {
        if (prs.some((p) => p.repo === wt.repo)) continue;
        const remote = await resolveRemote(wt.path);
        await git(['push', '--set-upstream', 'origin', wt.branch], wt.path, { timeoutMs: 180_000 });
        const refs = { source: wt.branch, target: target(wt.base) };
        const pr = await azdo.findActivePr(remote, refs) ?? await azdo.createPr(remote, { ...refs, title, description });
        prs.push({ repo: wt.repo, branch: wt.branch, target: refs.target, remote, ...pr, createdAt: new Date().toISOString(), completedAt: null });
        await writeJsonAtomic(prsFile(id), prs); // after each repo, so a failure on the second one keeps the first
        log('pr', `Pull request luotu: ${card.title} (${wt.repo} #${pr.id})`, { card: id });
      }
      return prs;
    } finally {
      locks.delete(id);
    }
  }

  const mergeFile = (id) => join(store.dir(id), 'merge.json');
  const isAzdoRepo = (path) => resolveRemote(path).then(() => true, () => false);

  /**
   * Whether the card's work can be accepted into its repository(ies) right here: it is in review, nothing was
   * published as a pull request, the worktrees still exist, and no repo is on Azure DevOps (those go through a PR).
   */
  async function canMergeLocal(id) {
    const card = await store.get(id);
    if (card.status !== 'review') return false;
    const run = await readJson(join(store.dir(id), 'run.json'), null);
    if (!run?.worktrees?.length || (await load(id)).length) return false;
    for (const wt of run.worktrees) {
      if (!existsSync(wt.path) || await isAzdoRepo(wt.path)) return false;
    }
    return true;
  }

  /**
   * Accepts the agent's work into the repository's base branch as ONE squash commit (message from commit-message.txt),
   * then marks the card done and removes its worktree and branch. Nothing is pushed. A repo must be on the base branch
   * with a clean working tree, so the person's own work is never mixed in; the old tip is kept as
   * refs/agentcontrol/premerge/<card> for an undo.
   */
  async function mergeLocal(id) {
    if (locks.has(id)) throw new ValidationError('A merge or publish is already in progress for this card');
    locks.add(id);
    try {
      const card = await store.get(id);
      if (!(await canMergeLocal(id))) throw new ValidationError('This card cannot be merged here (it must be in review, with its worktrees, and not on Azure DevOps)');
      const run = await readJson(join(store.dir(id), 'run.json'), null);
      // The agent's proposed squash message, as written (the PR description would add the report, which a commit should not carry).
      const message = (await readFile(join(store.dir(id), 'commit-message.txt'), 'utf8').catch(() => '')).trim() || card.title;
      const merged = await readJson(mergeFile(id), []);
      for (const wt of run.worktrees) {
        if (merged.some((m) => m.repo === wt.repo)) continue; // done earlier; a failure on a later repo keeps this one
        const repoPath = repos.path(wt.repo);
        const baseBranch = target(wt.base);
        const head = await git(['symbolic-ref', '--short', 'HEAD'], repoPath).catch(() => null);
        if (head !== baseBranch) throw new ValidationError(`${wt.repo} is on ${head ? `branch ${head}` : 'no branch'}, but the work is merged into ${baseBranch}. Switch it to ${baseBranch} first.`);
        if (await git(['status', '--porcelain'], repoPath)) throw new ValidationError(`${wt.repo} has changes that are not committed. Commit or stash them first, so they are not mixed into the merge.`);
        const before = await git(['rev-parse', 'HEAD'], repoPath);
        await git(['update-ref', `refs/agentcontrol/premerge/${id}`, before], repoPath);
        let commit = before;
        try {
          await git(['merge', '--squash', wt.branch], repoPath);
          if (await git(['status', '--porcelain'], repoPath)) {
            await git(['commit', '-q', '-m', message], repoPath);
            commit = await git(['rev-parse', 'HEAD'], repoPath);
          }
        } catch (e) {
          const files = (await git(['diff', '--name-only', '--diff-filter=U'], repoPath).catch(() => '')).split('\n').filter(Boolean);
          await git(['reset', '--hard', before], repoPath).catch((err) => log('merge', `${wt.repo}: reset --hard epäonnistui, tarkista repon tila (vanha kärki: ${before.slice(0, 7)}): ${err.message}`, { card: id, level: 'warn' })); // the tree was clean, so this only drops the failed merge
          if (files.length) {
            throw new MergeConflictError(`The work conflicts with changes already in ${baseBranch}, in: ${files.join(', ')}. Nothing was changed.`, files);
          }
          throw Object.assign(new ValidationError(`The merge into ${baseBranch} of ${wt.repo} did not go through (${e.message.split('\n')[0]}). Nothing was changed.`), { expose: true });
        }
        merged.push({ repo: wt.repo, branch: wt.branch, target: baseBranch, commit, before, at: new Date().toISOString() });
        await writeJsonAtomic(mergeFile(id), merged);
      }
      await cleanup(id, run);
      await store.update(id, { status: 'done' });
      log('merge', `Työ yhdistetty projektiin: ${card.title} (${merged.map((m) => `${m.repo}@${m.target} ${m.commit.slice(0, 7)}`).join(', ')})`, { card: id });
      return merged;
    } finally {
      locks.delete(id);
    }
  }

  async function cleanup(id, run) {
    for (const wt of run?.worktrees ?? []) {
      const repoPath = repos.path(wt.repo);
      await git(['worktree', 'remove', '--force', wt.path], repoPath).catch((e) => log('merge', `Worktreen poisto epäonnistui (${wt.path}): ${e.message}`, { card: id, level: 'warn' }));
      await git(['branch', '-D', wt.branch], repoPath).catch((e) => log('merge', `Haaran ${wt.branch} poisto epäonnistui: ${e.message}`, { card: id, level: 'warn' })); // squash merges leave it "unmerged" to git, so -D
    }
  }

  /** Refreshes active pull requests; a card whose PRs are all completed becomes done and its worktrees are removed. */
  async function poll({ force = false } = {}) {
    if (!force && Date.now() - lastPoll < pollMs) return;
    lastPoll = Date.now();
    for (const card of await store.list()) {
      if (card.status !== 'review' || locks.has(card.id)) continue;
      const prs = await load(card.id).catch(() => []);
      if (!prs.some((p) => p.state === 'active')) continue;
      let changed = false;
      for (const pr of prs.filter((p) => p.state === 'active')) {
        try {
          const fresh = await azdo.getPr(pr.remote, pr.id);
          if (fresh.state !== pr.state) {
            Object.assign(pr, { state: fresh.state, mergeStatus: fresh.mergeStatus, completedAt: fresh.state === 'completed' ? new Date().toISOString() : pr.completedAt });
            changed = true;
            log('pr', `Pull request ${fresh.state === 'completed' ? 'yhdistetty' : fresh.state === 'abandoned' ? 'hylätty' : fresh.state}: ${card.title} (${pr.repo} #${pr.id})`, { card: card.id });
          }
        } catch (e) {
          console.error(`poll PR ${pr.id} of ${card.id}:`, e.message);
        }
      }
      if (!changed) continue;
      await writeJsonAtomic(prsFile(card.id), prs);
      if (prs.every((p) => p.state === 'completed')) {
        await cleanup(card.id, await readJson(join(store.dir(card.id), 'run.json'), null));
        await store.update(card.id, { status: 'done' });
      }
    }
  }

  return {
    publish, poll, mergeLocal, canMergeLocal,
    get: async (id) => { await store.get(id); return load(id); },
    start: () => { if (!timer) timer = setInterval(() => poll().catch((e) => console.error('PR poll:', e.message)), Math.min(pollMs, 10_000)); },
    shutdown: () => { clearInterval(timer); timer = null; },
  };
}

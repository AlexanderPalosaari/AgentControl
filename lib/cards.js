import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './fsutil.js';

export const STATUSES = ['inbox', 'refining', 'ready', 'running', 'needs_input', 'review', 'done', 'archive'];
export const PRIORITIES = ['low', 'normal', 'high'];

/**
 * Moves a person may make by hand. The rest happen by themselves (refiner, runner, publisher) and
 * go through the store directly: a hand-made jump such as inbox -> running would skip the plan,
 * the worktree or the review and leave the card in a state nothing is watching.
 */
export const MANUAL_MOVES = {
  inbox: ['archive'],
  refining: ['inbox', 'archive'],
  ready: ['refining', 'archive'],
  running: [],                       // use Stop
  needs_input: ['archive'],
  review: ['done', 'archive'],
  done: ['review', 'archive'],
  archive: ['inbox', 'done'],
};
export const canMove = (from, to) => from === to || (MANUAL_MOVES[from] ?? []).includes(to);

const ID_RE = /^c-[a-z0-9]+$/;

/**
 * What a card waits for in the card it depends on (`after`): `done` = that card's implementation is finished,
 * `planned` = its plan is approved (it has left refining), so this one can be designed against it.
 */
export const AFTER_KINDS = ['done', 'planned'];
const MET = {
  done: new Set(['done', 'archive']),
  planned: new Set(['ready', 'running', 'needs_input', 'review', 'done', 'archive']),
};

/** What kind of card it is: `task` changes code; `research` only studies (code, documents, the web) and reports. */
export const CARD_KINDS = ['task', 'research'];

/**
 * A card's dependencies as [{ id, kind }]. Cards written before a card could have several kept one in
 * `after` / `afterKind`; those read as a list of one.
 */
export function depsOf(card) {
  if (Array.isArray(card?.deps)) return card.deps;
  return card?.after ? [{ id: card.after, kind: card.afterKind ?? 'done' }] : [];
}

/** Every dependency of `card` that is not met yet, as [{ dep, kind }] in the card's order. A deleted card is nothing to wait for. */
export function unmetDependencies(card, cards) {
  return depsOf(card).flatMap(({ id, kind }) => {
    const dep = cards.find((c) => c.id === id);
    return dep && !MET[kind ?? 'done'].has(dep.status) ? [{ dep, kind: kind ?? 'done' }] : [];
  });
}

/** The first card that `card` still waits for, or null when its dependencies are met (or it has none). */
export function unmetDependency(card, cards) {
  return unmetDependencies(card, cards)[0]?.dep ?? null;
}

/** Whether `card` waits for the card `id` (either kind). */
export const dependsOn = (card, id) => depsOf(card).some((d) => d.id === id);

export class ValidationError extends Error {}
/** The card's work and the base branch changed the same lines; `files` are the files in conflict. The agent can resolve it. */
export class MergeConflictError extends ValidationError {
  constructor(message, files = []) { super(message); this.files = files; }
}
export class NotFoundError extends Error {}
/** A step the person must confirm first (e.g. refining a card whose dependency is not met); `details` says why. */
export class ConfirmationError extends Error {
  constructor(message, details = {}) { super(message); this.details = details; }
}

const STATUS_LABEL = {
  inbox: 'Inbox', refining: 'Refining', ready: 'Ready', running: 'Running', needs_input: 'Needs input', review: 'Review', done: 'Done', archive: 'Archive',
};

/** Where a card's base branch can still change: its worktrees are made from it when the work starts. */
const BASE_EDITABLE = new Set(['inbox', 'refining', 'ready', 'needs_input', 'archive']);

/**
 * `log(kind, text, extra)`: the event journal (new cards and every column change); a no-op by default.
 * `checkBase(card)`: throws when the card's `baseBranch` is not in each of its repositories; called when either changes.
 */
export function createCardStore(dataDir, { log = () => {}, checkBase = async () => {} } = {}) {
  const cardsDir = join(dataDir, 'cards');
  const cardFile = (id) => join(cardsDir, id, 'card.json');

  const write = (card) => writeJsonAtomic(cardFile(card.id), card);

  // The runner and the page ask for every card several times a second. A card file is only parsed again when its
  // size or modification time changed; callers get a copy, since they edit what they read.
  const cache = new Map(); // id -> { sig, card }

  async function get(id) {
    if (!ID_RE.test(id)) throw new NotFoundError(`Card ${id} not found`);
    try {
      const s = await stat(cardFile(id));
      const sig = `${s.mtimeMs}|${s.size}`;
      let hit = cache.get(id);
      if (hit?.sig !== sig) {
        hit = { sig, card: normalize(JSON.parse(await readFile(cardFile(id), 'utf8'))) };
        cache.set(id, hit);
      }
      return structuredClone(hit.card);
    } catch (e) {
      cache.delete(id);
      if (e.code === 'ENOENT') throw new NotFoundError(`Card ${id} not found`);
      throw e;
    }
  }

  async function list() {
    let ids;
    try {
      ids = await readdir(cardsDir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const cards = [];
    for (const id of ids.filter((i) => ID_RE.test(i))) {
      try {
        cards.push(await get(id));
      } catch (e) {
        if (!(e instanceof NotFoundError)) console.error(`Skipping unreadable card ${id}:`, e.message);
      }
    }
    return cards.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function create(input) {
    const title = str(input.title);
    const brief = str(input.brief);
    if (!title) throw new ValidationError('title is required');
    const priority = input.priority ?? 'normal';
    if (!PRIORITIES.includes(priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join(', ')}`);
    const repos = strList(input.repos);
    const deps = parseDeps(input);
    for (const d of deps) await get(d.id).catch(() => { throw new ValidationError(`deps: card ${d.id} not found`); });
    const kind = input.kind ?? 'task';
    if (!CARD_KINDS.includes(kind)) throw new ValidationError(`kind must be one of ${CARD_KINDS.join(', ')}`);
    const now = new Date().toISOString();
    const card = {
      id: `c-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      title,
      brief,
      repos,
      priority,
      kind,
      deps,
      model: str(input.model) || null,
      effort: str(input.effort) || null,
      // The branch the work forks from and goes back into (pull request target); null = the project's, else the repository's default.
      baseBranch: normalizeBranch(input.baseBranch),
      project: str(input.project) || null, // set on a project's planning card: the project dialog stands in for refinement
      status: 'inbox',
      createdAt: now,
      updatedAt: now,
    };
    if (card.baseBranch) await checkBase(card);
    await write(card);
    log('card', `Uusi ${kind === 'research' ? 'selvityskortti' : 'kortti'}: ${card.title}${repos.length ? ` (${repos.join(', ')})` : ''}`, { card: card.id });
    return card;
  }

  async function update(id, patch) {
    const card = await get(id);
    const from = card.status;
    if ('status' in patch) {
      if (!STATUSES.includes(patch.status)) throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`);
      card.status = patch.status;
    }
    if ('title' in patch) {
      card.title = str(patch.title);
      if (!card.title) throw new ValidationError('title is required');
    }
    if ('brief' in patch) card.brief = str(patch.brief);
    if ('model' in patch) card.model = str(patch.model) || null;
    if ('effort' in patch) card.effort = str(patch.effort) || null;
    if ('repos' in patch) card.repos = strList(patch.repos);
    if ('baseBranch' in patch) {
      const baseBranch = normalizeBranch(patch.baseBranch);
      if (baseBranch !== (card.baseBranch ?? null) && !BASE_EDITABLE.has(from)) {
        throw new ValidationError(`The work has already started from ${card.baseBranch ?? 'the default branch'}; the base branch cannot change in ${STATUS_LABEL[from]}`);
      }
      card.baseBranch = baseBranch;
    }
    if (card.baseBranch && ('baseBranch' in patch || 'repos' in patch)) await checkBase(card);
    if ('priority' in patch) {
      if (!PRIORITIES.includes(patch.priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join(', ')}`);
      card.priority = patch.priority;
    }
    if ('kind' in patch) {
      if (!CARD_KINDS.includes(patch.kind)) throw new ValidationError(`kind must be one of ${CARD_KINDS.join(', ')}`);
      if (patch.kind !== card.kind && !['inbox', 'refining', 'archive'].includes(from)) throw new ValidationError(`A card's kind cannot change in ${STATUS_LABEL[from]}`);
      card.kind = patch.kind;
    }
    if ('deps' in patch || 'after' in patch || 'afterKind' in patch) {
      let deps;
      if ('deps' in patch || 'after' in patch) deps = parseDeps(patch);
      else { // `afterKind` alone: the old one-dependency API changing the kind of what the card waits for
        if (!AFTER_KINDS.includes(patch.afterKind)) throw new ValidationError(`afterKind must be one of ${AFTER_KINDS.join(', ')}`);
        deps = card.deps.map((d) => ({ ...d, kind: patch.afterKind }));
      }
      // Walk every chain from the new dependencies: reaching this card again would be a cycle nothing can start.
      const seen = new Set();
      const walk = async (at) => {
        if (at === id) throw new ValidationError('deps: that dependency would make a cycle');
        if (seen.has(at)) return;
        seen.add(at);
        if (seen.size > 5000) throw new ValidationError('deps: the dependency chain is too long');
        const dep = await get(at).catch(() => { throw new ValidationError(`deps: card ${at} not found`); });
        for (const d of dep.deps) await walk(d.id);
      };
      for (const d of deps) await walk(d.id);
      card.deps = deps;
    }
    card.updatedAt = new Date().toISOString();
    await write(card);
    if (card.status !== from) log('card', `${card.title}: ${STATUS_LABEL[from]} → ${STATUS_LABEL[card.status]}`, { card: id });
    return card;
  }

  const dir = (id) => join(cardsDir, id);

  return { get, list, create, update, dir };
}

/** A card as the code expects it: `kind` and `deps` always there, the old single-dependency fields folded into `deps`. */
function normalize(card) {
  card.deps = depsOf(card);
  delete card.after;
  delete card.afterKind;
  card.kind ??= 'task';
  return card;
}

/**
 * The dependencies a request asks for: `deps` (a list of { id, kind } or plain ids), or the old single
 * `after` + `afterKind`. Duplicates are merged, keeping the first kind given.
 */
function parseDeps(input) {
  let list;
  if (input.deps != null) {
    if (!Array.isArray(input.deps)) throw new ValidationError('deps must be an array of { id, kind }');
    list = input.deps.map((d) => (typeof d === 'string' ? { id: d } : d ?? {}));
  } else {
    list = input.after ? [{ id: input.after, kind: input.afterKind }] : [];
  }
  const out = [];
  for (const d of list) {
    const id = str(d.id);
    if (!id) throw new ValidationError('deps: every dependency needs a card id');
    const kind = d.kind ?? 'done';
    if (!AFTER_KINDS.includes(kind)) throw new ValidationError(`deps: kind must be one of ${AFTER_KINDS.join(', ')}`);
    if (!out.some((x) => x.id === id)) out.push({ id, kind });
  }
  return out;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * A branch name as a person writes it (features/x, origin/features/x, refs/heads/features/x) as the plain name,
 * or null when empty. Throws a ValidationError for anything git would not take as a branch name.
 */
export function normalizeBranch(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new ValidationError('baseBranch must be a branch name, e.g. features/maui-dev');
  const name = value.trim().replace(/^refs\/heads\//, '').replace(/^(refs\/remotes\/)?origin\//, '');
  if (!name) return null;
  if (name.length > 200 || name === 'HEAD' || /^[-/.]|[/.]$|\.\.|\/\/|@\{|\.lock(\/|$)|\/\.|[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) {
    throw new ValidationError(`"${value}" is not a valid branch name`);
  }
  return name;
}

function strList(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ValidationError('repos must be an array of strings');
  return v.map(str).filter(Boolean);
}

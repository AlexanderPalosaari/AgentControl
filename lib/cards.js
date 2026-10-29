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

/** The card that `card` still waits for, or null when its dependency is met (or it has none). */
export function unmetDependency(card, cards) {
  if (!card.after) return null;
  const dep = cards.find((c) => c.id === card.after);
  if (!dep) return null; // nothing left to wait for
  return MET[card.afterKind ?? 'done'].has(dep.status) ? null : dep;
}

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

/** `log(kind, text, extra)`: the event journal (new cards and every column change); a no-op by default. */
export function createCardStore(dataDir, { log = () => {} } = {}) {
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
        hit = { sig, card: JSON.parse(await readFile(cardFile(id), 'utf8')) };
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
    const after = input.after ? str(input.after) : null;
    if (after) await get(after).catch(() => { throw new ValidationError(`after: card ${after} not found`); });
    const afterKind = input.afterKind ?? 'done';
    if (!AFTER_KINDS.includes(afterKind)) throw new ValidationError(`afterKind must be one of ${AFTER_KINDS.join(', ')}`);
    const now = new Date().toISOString();
    const card = {
      id: `c-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      title,
      brief,
      repos,
      priority,
      after,
      afterKind: after ? afterKind : null,
      model: str(input.model) || null,
      effort: str(input.effort) || null,
      project: str(input.project) || null, // set on a project's planning card: the project dialog stands in for refinement
      status: 'inbox',
      createdAt: now,
      updatedAt: now,
    };
    await write(card);
    log('card', `Uusi kortti: ${card.title}${repos.length ? ` (${repos.join(', ')})` : ''}`, { card: card.id });
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
    if ('priority' in patch) {
      if (!PRIORITIES.includes(patch.priority)) throw new ValidationError(`priority must be one of ${PRIORITIES.join(', ')}`);
      card.priority = patch.priority;
    }
    if ('after' in patch || 'afterKind' in patch) {
      const after = 'after' in patch ? (patch.after ? str(patch.after) : null) : card.after;
      const afterKind = patch.afterKind ?? card.afterKind ?? 'done';
      if (!AFTER_KINDS.includes(afterKind)) throw new ValidationError(`afterKind must be one of ${AFTER_KINDS.join(', ')}`);
      // Walk the chain from the new dependency: reaching this card again would be a cycle nothing can start.
      for (let at = after, seen = 0; at; seen++) {
        if (at === id || seen > 1000) throw new ValidationError('after: that dependency would make a cycle');
        at = (await get(at).catch(() => { throw new ValidationError(`after: card ${at} not found`); })).after;
      }
      card.after = after;
      card.afterKind = after ? afterKind : null;
    }
    card.updatedAt = new Date().toISOString();
    await write(card);
    if (card.status !== from) log('card', `${card.title}: ${STATUS_LABEL[from]} → ${STATUS_LABEL[card.status]}`, { card: id });
    return card;
  }

  const dir = (id) => join(cardsDir, id);

  return { get, list, create, update, dir };
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ValidationError('repos must be an array of strings');
  return v.map(str).filter(Boolean);
}

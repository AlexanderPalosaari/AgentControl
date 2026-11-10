import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ValidationError } from './cards.js';
import { emptyUsage } from './usage.js';

const STATUS_NAME = { inbox: 'Inbox', refining: 'Refining', ready: 'Ready', running: 'Running', needs_input: 'Needs input', review: 'Review', done: 'Done', archive: 'Archive' };
const JOURNAL_LINES = 50_000; // the journal keeps ~5 MB per file; a busy day is a few thousand lines

/** The local calendar day of a time as YYYY-MM-DD, so "today" matches the person's clock. */
export const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The first line of a report that says something: not a heading, a rule or empty. */
function firstPoint(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.replace(/^[\s>*-]+/, '').replace(/\*\*/g, '').trim();
    if (l && !l.startsWith('#') && !/^[-=_]{3,}$/.test(l)) return l.length > 220 ? `${l.slice(0, 219)}…` : l;
  }
  return '';
}

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n));

/**
 * What happened on one day, from what is already on disk: the event journal (card moves, agents, merges, pull
 * requests, refinements), the cards with their reports and commit messages, and the token ledger. No model is
 * asked, so it costs nothing and is ready at once.
 * Returns { day, counts, done, review, inProgress, created, merged, prs, problems, tokens, markdown }.
 */
export function createDaySummary({ journal, store, ledger }) {
  async function summary({ day = localDay(Date.now()) } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ValidationError('day must be YYYY-MM-DD');
    const events = (await journal.tail(JOURNAL_LINES)).filter((e) => e.t && localDay(e.t) === day);
    const cards = await store.list();
    const byId = new Map(cards.map((c) => [c.id, c]));
    const read = (id, name) => readFile(join(store.dir(id), name), 'utf8').catch(() => '');

    // Per card: where it went today (from the "title: A → B" lines) and what else happened to it.
    const moves = new Map();   // card id -> [to, ...]
    const touched = new Set();
    const has = (re) => events.filter((e) => re.test(e.text));
    for (const e of events) {
      if (!e.card || !byId.has(e.card)) continue;
      touched.add(e.card);
      const m = e.kind === 'card' && / → ([A-Za-z ]+)$/.exec(e.text);
      if (m) moves.set(e.card, [...(moves.get(e.card) ?? []), m[1].trim()]);
    }
    const wentTo = (id, label) => (moves.get(id) ?? []).includes(label);

    const describe = async (c) => {
      const report = firstPoint(await read(c.id, 'report.md'));
      const commit = (await read(c.id, 'commit-message.txt')).split('\n')[0].trim();
      return { id: c.id, title: c.title, kind: c.kind ?? 'task', status: c.status, repos: c.repos, what: commit || report, report };
    };

    const doneCards = cards.filter((c) => wentTo(c.id, 'Done'));
    const reviewCards = cards.filter((c) => c.status === 'review' && wentTo(c.id, 'Review'));
    const created = events.filter((e) => e.kind === 'card' && /^Uusi (kortti|selvityskortti):/.test(e.text) && e.card)
      .map((e) => byId.get(e.card)).filter(Boolean);
    const createdIds = new Set(created.map((c) => c.id));
    // Worked on but not finished today: an agent or refiner was on it, or it moved, and it is still under way.
    const inProgress = cards.filter((c) => touched.has(c.id) && !doneCards.includes(c) && !reviewCards.includes(c)
      && ['refining', 'ready', 'running', 'needs_input'].includes(c.status) && (moves.has(c.id) || events.some((e) => e.card === c.id && e.kind !== 'card')));

    const merged = has(/^Työ yhdistetty projektiin:/).map((e) => e.text.replace(/^Työ yhdistetty projektiin:\s*/, ''));
    const prsOpened = has(/^Pull request luotu:/).length;
    const prsMerged = has(/^Pull request yhdistetty:/).length;
    const problems = events.filter((e) => e.level === 'error').map((e) => ({ t: e.t, text: e.text, card: e.card ?? null }));

    const usage = ledger ? (await ledger.summary({ days: 400 })).byDay.find((d) => d.day === day) ?? null : null;
    const tokens = usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : emptyUsage();

    const counts = {
      done: doneCards.length,
      review: reviewCards.length,
      created: created.length,
      agentsStarted: has(/(Agentti|Selvitysagentti) käynnistyi:/).length,
      research: has(/^Selvitys valmis:/).length,
      refined: has(/^Tarkennus valmis:/).length,
      questions: has(/^Agentti (kysyy|pyytää lupaa):/).length,
      merged: merged.length,
      prsOpened,
      prsMerged,
      errors: problems.length,
    };

    const result = {
      day,
      counts,
      done: await Promise.all(doneCards.map(describe)),
      review: await Promise.all(reviewCards.map(describe)),
      inProgress: inProgress.map((c) => ({ id: c.id, title: c.title, kind: c.kind ?? 'task', status: c.status, statusName: STATUS_NAME[c.status] })),
      created: created.filter((c) => createdIds.has(c.id)).map((c) => ({ id: c.id, title: c.title, kind: c.kind ?? 'task', status: c.status })),
      merged,
      problems: problems.slice(-10),
      tokens,
      quiet: events.length === 0,
    };
    result.markdown = toMarkdown(result);
    return result;
  }

  return { summary };
}

function toMarkdown(s) {
  const [y, m, d] = s.day.split('-').map(Number);
  const out = [`# Päivän yhteenveto ${d}.${m}.${y}`, ''];
  if (s.quiet) return [...out, 'Tältä päivältä ei ole tapahtumia.'].join('\n');
  const c = s.counts;
  const facts = [
    c.done && `${c.done} valmista`, c.review && `${c.review} katselmoitavana`, c.created && `${c.created} uutta korttia`,
    c.agentsStarted && `${c.agentsStarted} agenttiajoa`, c.refined && `${c.refined} tarkennusta`, c.research && `${c.research} selvitystä`,
    c.merged && `${c.merged} yhdistetty projektiin`, c.prsOpened && `${c.prsOpened} PR:ää avattu`, c.prsMerged && `${c.prsMerged} PR:ää yhdistetty`,
  ].filter(Boolean);
  const tok = s.tokens.input + s.tokens.output;
  out.push(facts.length ? facts.join(' · ') : 'Ei valmistuneita töitä.');
  if (tok) out.push(`Tokeneita ${fmtTokens(tok)} (lisäksi välimuistista ${fmtTokens(s.tokens.cacheRead)})`);
  const item = (x) => `- ${x.kind === 'research' ? '[Selvitys] ' : ''}**${x.title}**${x.what ? `: ${x.what}` : ''}`;
  if (s.done.length) out.push('', '## Valmistui', ...s.done.map(item));
  if (s.review.length) out.push('', '## Odottaa katselmointia', ...s.review.map(item));
  if (s.inProgress.length) out.push('', '## Kesken', ...s.inProgress.map((x) => `- ${x.title} (${x.statusName})`));
  if (s.created.length) out.push('', '## Uudet kortit', ...s.created.map((x) => `- ${x.kind === 'research' ? '[Selvitys] ' : ''}${x.title}`));
  if (s.problems.length) out.push('', `## Virheet (${c.errors})`, ...s.problems.map((p) => `- ${p.text.split('\n')[0].slice(0, 200)}`));
  return out.join('\n');
}

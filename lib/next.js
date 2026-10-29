import { unmetDependency } from './cards.js';

/** The first line that says something: Markdown headings ("# Kysymys") are skipped, list and quote marks dropped. */
const firstLine = (s, n = 140) => {
  const lines = String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = (lines.find((l) => !l.startsWith('#')) ?? lines[0] ?? '').replace(/^[#>*\-\s]+/, '').trim();
  return line.length > n ? `${line.slice(0, n)}…` : line;
};

/**
 * What the board needs from the person, most urgent first, and what is going on without them.
 * yourTurn: [{ card?, project?, title, what, detail, action }], working: [text], waiting: [text].
 */
const STATUS_NAME = { inbox: 'Inbox', refining: 'Refining', ready: 'Ready', running: 'Running', needs_input: 'Needs input', review: 'Review', done: 'Done', archive: 'Archive' };

export function createNextSteps({ store, refiner, runner, projects, publisher = null }) {
  async function list() {
    const hidden = await projects.hiddenCards?.() ?? (() => false); // a hidden project's cards ask nothing of the person here
    const cards = (await store.list()).filter((c) => c.status !== 'archive' && c.status !== 'done' && !hidden(c));
    const yourTurn = [];
    const working = [];
    const waiting = [];
    const add = (rank, item) => yourTurn.push({ rank, ...item });

    for (const c of cards) {
      const base = { card: c.id, title: c.title };
      if (c.project) {
        if (c.status === 'needs_input') {
          const p = await projects.get(c.project).catch(() => null);
          if (p?.step === 'review') add(2, { ...base, project: c.project, what: 'Projektin suunnitelma odottaa hyväksyntää', detail: `${p.planning.tasks.length} tehtävää`, action: 'Tarkista ja luo kortit' });
          else if (p) add(2, { ...base, project: c.project, what: 'Projektin suunnittelu jäi kesken', detail: firstLine(p.planning.error) || 'Kuvaus puuttuu', action: 'Kuvaile projekti' });
        }
        continue; // its planning is counted with the projects below
      }
      if (c.status === 'needs_input') {
        const d = await runner.details(c.id).catch(() => null);
        if (d?.question) add(1, { ...base, what: 'Agentti kysyy', detail: firstLine(d.question), action: 'Vastaa' });
        else if (d?.run?.waitingFor) add(1, { ...base, what: 'Agentti pyytää lupaa', detail: 'Komento odottaa hyväksyntääsi terminaali-ikkunassa', action: 'Avaa lupakysely', attach: true });
        else add(1, { ...base, what: 'Agentti pysähtyi', detail: firstLine(d?.run?.error ?? d?.run?.waitingFor) || 'Katso mitä tapahtui', action: 'Katso ja yritä uudelleen' });
      } else if (c.status === 'refining') {
        const r = await refiner.get(c.id).catch(() => null);
        if (r?.state === 'running') working.push(`Tarkennus: ${c.title}`);
        else if (r?.state === 'error') add(3, { ...base, what: 'Tarkennus epäonnistui', detail: firstLine(r.error), action: 'Yritä uudelleen' });
        else if (r?.questions?.length) add(3, { ...base, what: `Tarkentaja kysyy (${r.questions.length})`, detail: firstLine(r.questions[0].text), action: 'Vastaa kysymyksiin' });
        else if (r?.plan) add(4, { ...base, what: 'Suunnitelma valmis', detail: firstLine(r.summary || r.plan), action: 'Hyväksy (Start work)' });
        else add(4, { ...base, what: 'Tarkennus ei ole alkanut', detail: '', action: 'Aloita tarkennus' });
      } else if (c.status === 'review') {
        // A repo without a pull-request host (e.g. a local project) cannot make a PR: the work is accepted into the repo instead.
        const local = await publisher?.canMergeLocal(c.id).catch(() => false);
        const blocked = cards.filter((x) => x.after === c.id).length;
        add(5, {
          ...base, what: 'Valmis katselmoitavaksi',
          detail: local ? `Lue raportti ja muutokset, hyväksy sitten työ projektiin${blocked ? ` (${blocked} korttia odottaa tätä)` : ''}` : 'Lue raportti ja muutokset',
          action: local ? 'Hyväksy työ projektiin' : 'Katselmoi ja luo PR',
        });
      } else if (c.status === 'running') {
        working.push(`Toteutus: ${c.title}`);
      } else if (c.status === 'ready') {
        const dep = unmetDependency(c, cards);
        waiting.push(dep ? `Ready, odottaa korttia "${dep.title}": ${c.title}` : `Ready, odottaa vapaata agenttipaikkaa: ${c.title}`);
      }
    }

    // Inbox: the cards that could be started now, as one entry, so a long backlog does not crowd the list.
    const inbox = cards.filter((c) => c.status === 'inbox' && !c.project);
    const startable = inbox.filter((c) => !unmetDependency(c, cards));
    if (startable.length) {
      add(6, { card: startable[0].id, title: startable.length === 1 ? startable[0].title : `${startable.length} korttia voi aloittaa`, what: 'Inbox', detail: startable.slice(0, 3).map((c) => c.title).join(' · ') + (startable.length > 3 ? ` (+${startable.length - 3})` : ''), action: 'Aloita tarkennus' });
    }
    // What the blocked cards actually wait for: the first card up each dependency chain that is not itself blocked.
    const rootBlocker = (c, seen = new Set()) => {
      const dep = unmetDependency(c, cards);
      if (!dep || seen.has(dep.id)) return dep ? { dep, kind: c.afterKind ?? 'done' } : null;
      seen.add(dep.id);
      return rootBlocker(dep, seen) ?? { dep, kind: c.afterKind ?? 'done' };
    };
    const groups = new Map();
    for (const c of inbox.filter((x) => unmetDependency(x, cards))) {
      const b = rootBlocker(c);
      if (b) groups.set(b.dep.id, { ...b, n: (groups.get(b.dep.id)?.n ?? 0) + 1 });
    }
    for (const { dep, kind, n } of groups.values()) {
      waiting.push(`${n} ${n === 1 ? 'kortti' : 'korttia'} odottaa kortin "${dep.title}" ${kind === 'planned' ? 'suunnitelman hyväksyntää' : 'toteutuksen valmistumista (Done)'} (nyt ${STATUS_NAME[dep.status] ?? dep.status})`);
    }

    for (const p of await projects.list()) {
      if (p.hidden) continue;
      if (p.step === 'planning') working.push(`Projektin suunnittelu: ${p.name}`);
      else if (p.step === 'remote') add(2, { project: p.name, title: p.name, what: 'GitHub-vaihe jäi kesken', detail: firstLine(p.sourceControl.error), action: 'Yritä uudelleen' });
      else if (p.step === 'describe' && !p.planCard) add(2, { project: p.name, title: p.name, what: 'Projekti odottaa kuvausta', detail: '', action: 'Kuvaile projekti' });
    }

    yourTurn.sort((a, b) => a.rank - b.rank);
    return { yourTurn: yourTurn.map(({ rank, ...item }) => item), working, waiting };
  }
  return { list };
}

const QUIET_MS = 15 * 60_000; // a running agent that has changed nothing for this long is flagged as quiet
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const span = (ms) => (minutes(ms) < 60 ? `${minutes(ms)} min` : `${Math.floor(minutes(ms) / 60)} h ${minutes(ms) % 60} min`);

/**
 * One answer per card to "what is happening to this card right now": { key, label, tone, reason }.
 * `tone` says who holds the card: you (needs the person), work (an agent is on it), wait (queued or blocked), idle.
 * A card's column (status) is where it is in the flow; this is what it is doing there.
 */
export function createPhases({ store, refiner, runner, projects, now = () => Date.now() }) {
  async function list() {
    const cards = await store.list();
    const live = cards.filter((c) => c.status !== 'archive');
    const queue = await runner.queue().catch(() => null);
    const title = (id) => cards.find((c) => c.id === id)?.title ?? id;
    const out = {};
    const usage = { runsToday: 0, agentMs: 0 };
    const midnight = new Date(now()).setHours(0, 0, 0, 0);

    for (const c of live) {
      const phase = (key, label, tone, reason = '', extra = {}) => { out[c.id] = { key, label, tone, reason, ...extra }; };
      const run = c.status === 'inbox' || c.status === 'refining' ? null : await runner.run(c.id).catch(() => null);
      if (run?.startedAt && Date.parse(run.startedAt) >= midnight) {
        usage.runsToday += 1;
        const end = run.finishedAt ? Date.parse(run.finishedAt) : run.state === 'running' || run.state === 'reviewing' ? now() : Date.parse(run.updatedAt);
        usage.agentMs += Math.max(0, end - Date.parse(run.startedAt));
      }
      const dep = unmetDependency(c, cards);
      const waitsFor = dep ? `Odottaa korttia "${dep.title}" (${c.afterKind === 'planned' ? 'suunnitelman hyväksyntää' : 'valmistumista'}, nyt ${STATUS_NAME[dep.status] ?? dep.status})` : '';

      if (c.project) {
        if (c.status === 'needs_input') phase('project', 'Projekti odottaa sinua', 'you', 'Suunnitelma tai kuvaus odottaa projektin ikkunassa');
        else phase('project', 'Projektin suunnittelu', 'work');
      } else if (c.status === 'inbox') {
        if (dep) phase('inbox-blocked', 'Inbox', 'wait', waitsFor);
        else phase('inbox', 'Inbox', 'idle', 'Voi aloittaa tarkennuksen');
      } else if (c.status === 'refining') {
        const r = await refiner.get(c.id).catch(() => null);
        if (r?.state === 'running') phase('refining', 'Tarkentaa', 'work', `Tarkentaja on töissä (vuoro ${r.turn ?? 1})`);
        else if (r?.state === 'error') phase('refine-error', 'Tarkennus epäonnistui', 'you', firstLine(r.error));
        else if (r?.questions?.length) phase('refine-questions', `Kysyy sinulta (${r.questions.length})`, 'you', 'Vastaa tarkentajan kysymyksiin');
        else if (r?.plan) phase('plan-ready', 'Suunnitelma odottaa', 'you', 'Tarkennus on valmis: hyväksy suunnitelma (Start work) tai pyydä muutoksia');
        else phase('refine-idle', 'Tarkennus ei ole alkanut', 'idle', 'Aloita tarkennus');
      } else if (c.status === 'ready') {
        if (dep) phase('ready-blocked', 'Jonossa', 'wait', waitsFor);
        else if (queue && !queue.enabled) phase('ready-paused', 'Jonossa', 'wait', 'Käynnistys on pysäytetty (Asetukset)');
        else if (queue) {
          const pos = queue.order.indexOf(c.id) + 1;
          const free = Math.max(0, queue.limit - queue.running);
          if (pos && pos <= free) phase('ready-next', 'Käynnistyy pian', 'wait', 'Paikka on vapaa, agentti käynnistyy seuraavassa tarkistuksessa');
          else phase('ready-full', 'Jonossa', 'wait', `Agenttipaikat täynnä (${queue.running}/${queue.limit}${queue.night ? ', yö' : ', päivä'}), jonossa nro ${Math.max(1, pos - free)}`);
        } else phase('ready', 'Jonossa', 'wait', 'Odottaa vapaata agenttipaikkaa');
      } else if (c.status === 'running') {
        if (run?.state === 'reviewing') phase('reviewing', 'Katselmoidaan', 'work', 'Automaattinen katselmointi käynnissä');
        else {
          const last = await runner.lastActivity(c.id).catch(() => null);
          const quiet = last ? now() - last : 0;
          const since = run?.startedAt ? `käynnissä ${span(now() - Date.parse(run.startedAt))}` : '';
          if (quiet >= QUIET_MS) phase('running-quiet', 'Toteuttaa · hiljaista', 'work', `Ei muutoksia ${span(quiet)}${since ? `, ${since}` : ''}. Voi lukea koodia tai olla jumissa: tarkista live-loki`, { quiet: true, quietMs: quiet });
          else phase('running', 'Toteuttaa', 'work', since);
        }
      } else if (c.status === 'needs_input') {
        const d = await runner.details(c.id).catch(() => null);
        if (d?.question) phase('asking', 'Agentti kysyy', 'you', firstLine(d.question));
        else if (d?.run?.waitingFor) phase('permission', 'Odottaa lupaa', 'you', 'Lupakysely odottaa terminaali-ikkunassa');
        else phase('stopped', 'Agentti pysähtyi', 'you', firstLine(d?.run?.error) || 'Katso mitä tapahtui');
      } else if (c.status === 'review') {
        phase('review', 'Katselmoitavana', 'you', 'Lue raportti ja muutokset');
      } else if (c.status === 'done') {
        phase('done', 'Valmis', 'idle');
      }
    }
    return { cards: out, usage: { runsToday: usage.runsToday, agentMinutes: Math.round(usage.agentMs / 60_000) } };
  }
  return { list };
}

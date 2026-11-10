'use strict';
// dependency graph, the card element, notifications and the board refresh.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- dependency graph: the cards that wait for each other, in columns by how deep in the chain they are ----
// A card may wait for several cards, so the chains form a graph, not a tree: each group of connected cards is
// drawn as columns (a card one column right of the deepest card it waits for), the longest unfinished chain in bold.
function renderGraph() {
  const box = document.getElementById('graph');
  if (document.body.dataset.view !== 'riippuvuudet') return;
  const live = cards.filter((c) => c.status !== 'archive');
  const byId = new Map(live.map((c) => [c.id, c]));
  const parents = new Map(live.map((c) => [c.id, cardDeps(c).filter((d) => byId.has(d.id))]));
  const kids = new Map();
  for (const c of live) for (const d of parents.get(c.id)) kids.set(d.id, [...(kids.get(d.id) ?? []), c]);
  const linked = live.filter((c) => parents.get(c.id).length || kids.has(c.id));
  // Connected groups (ignoring direction), each drawn as its own diagram.
  const groupOf = new Map();
  for (const c of linked) {
    if (groupOf.has(c.id)) continue;
    const g = [];
    const stack = [c];
    groupOf.set(c.id, g);
    while (stack.length) {
      const at = stack.pop();
      g.push(at);
      for (const n of [...parents.get(at.id).map((d) => byId.get(d.id)), ...(kids.get(at.id) ?? [])]) {
        if (!groupOf.has(n.id)) { groupOf.set(n.id, g); stack.push(n); }
      }
    }
  }
  const groups = [...new Set(groupOf.values())];
  const W = 230, H = 54, GX = 70, GY = 16;
  const NS = 'http://www.w3.org/2000/svg';
  const add = (parent, tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    parent.append(e);
    return e;
  };
  const parts = groups.map((group) => {
    // Column = the longest path from a card that waits for nothing (the server refuses cycles; `seen` guards anyway).
    const col = new Map();
    const colOf = (c, seen = new Set()) => {
      if (col.has(c.id)) return col.get(c.id);
      if (seen.has(c.id)) return 0;
      seen.add(c.id);
      const v = Math.max(-1, ...parents.get(c.id).map((d) => colOf(byId.get(d.id), seen))) + 1;
      col.set(c.id, v);
      return v;
    };
    for (const c of group) colOf(c);
    // The critical chain: from the start card with the longest chain below it, always on to its deepest child.
    const below = new Map();
    const depthBelow = (c) => {
      if (below.has(c.id)) return below.get(c.id);
      below.set(c.id, 1);
      const v = 1 + Math.max(0, ...(kids.get(c.id) ?? []).map(depthBelow));
      below.set(c.id, v);
      return v;
    };
    const critical = new Set();
    let at = group.filter((c) => !parents.get(c.id).length).sort((a, b) => depthBelow(b) - depthBelow(a))[0];
    while (at && !critical.has(at.id)) { critical.add(at.id); at = [...(kids.get(at.id) ?? [])].sort((a, b) => depthBelow(b) - depthBelow(a))[0]; }
    // Rows: each column ordered by where the cards it waits for are, so edges cross less.
    const rowOf = new Map();
    const columns = [];
    for (const c of group) (columns[col.get(c.id)] ??= []).push(c);
    for (const list of columns) {
      if (!list) continue;
      const key = (c) => { const r = parents.get(c.id).map((d) => rowOf.get(d.id)).filter((v) => v != null); return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0; };
      list.sort((a, b) => key(a) - key(b) || a.createdAt.localeCompare(b.createdAt)).forEach((c, y) => rowOf.set(c.id, y));
    }
    const pos = (c) => ({ x: col.get(c.id) * (W + GX), y: rowOf.get(c.id) * (H + GY) });
    const width = Math.max(...group.map((c) => pos(c).x)) + W + 4, height = Math.max(...group.map((c) => pos(c).y)) + H + 4;
    const svg = add(document.createDocumentFragment(), 'svg', { width, height, viewBox: `0 0 ${width} ${height}` });
    for (const to of group) {
      for (const d of parents.get(to.id)) {
        const from = byId.get(d.id);
        const a = pos(from), b = pos(to);
        const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
        const blocking = !AFTER_MET[d.kind ?? 'done'].includes(from.status);
        const crit = critical.has(from.id) && critical.has(to.id) && to.status !== 'done';
        add(svg, 'path', { d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, class: `g-edge${blocking ? ' blocking' : ''}${crit ? ' crit' : ''}` });
      }
    }
    for (const c of group) {
      const { x, y } = pos(c);
      const ph = phaseInfo.cards[c.id];
      const label = `${c.kind === 'research' ? 'Selvitys · ' : ''}${ph?.label ?? LABELS[c.status]}`;
      const g = add(svg, 'g', { class: `g-node s-${c.status} ${ph ? `tone-${ph.tone}` : ''}`, transform: `translate(${x} ${y})`, tabindex: 0 });
      add(g, 'title', {}, `${c.title}\n${label}${ph?.reason ? `: ${ph.reason}` : ''}`);
      add(g, 'rect', { width: W, height: H, rx: 8 });
      add(g, 'text', { x: 12, y: 22 }, c.title.length > 30 ? `${c.title.slice(0, 29)}…` : c.title);
      add(g, 'text', { x: 12, y: 41, class: 'sub' }, label.length > 36 ? `${label.slice(0, 35)}…` : label);
      g.addEventListener('click', () => openDetail(c.id));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(c.id); });
    }
    const left = group.filter((c) => c.status !== 'done').length;
    const first = group.filter((c) => !parents.get(c.id).length).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? group[0];
    return el('div', { className: 'tree' }, el('h2', { textContent: first.repos[0] ?? first.title }, el('span', { textContent: `${group.length} korttia, ${left} kesken` })), svg);
  });
  const alone = live.length - linked.length;
  box.replaceChildren(
    el('div', { className: 'legend', textContent: 'Kortti on sarakkeessa oikealla kaikista korteista, joita se odottaa. Paksu viiva: pisin ketju (ratkaisee, milloin viimeinen kortti voi valmistua). Katkoviiva: riippuvuus ei ole vielä täyttynyt. Klikkaa korttia avataksesi sen.' }),
    ...(parts.length ? parts : [el('div', { className: 'muted', textContent: 'Ei korttiketjuja. Kun kortille lisätään riippuvuus, ketju näkyy tässä.' })]),
    ...(alone > 0 && parts.length ? [el('div', { className: 'muted', textContent: `${alone} korttia ilman riippuvuuksia ei näy kaaviossa.` })] : []));
}

function renderCard(c) {
  const sel = el('select', { title: 'Siirrä' });
  for (const s of [c.status, ...(meta.moves[c.status] ?? [])]) sel.append(el('option', { value: s, textContent: s === c.status ? LABELS[s] : `→ ${LABELS[s]}`, selected: s === c.status }));
  sel.disabled = sel.options.length < 2; // e.g. a running card: use Stop
  sel.addEventListener('change', async () => {
    try { await api(`/api/cards/${c.id}`, { method: 'PATCH', body: { status: sel.value } }); await refresh(true); }
    catch (e) { toast(e.message); await refresh(true); }
  });
  const meta_ = el('div', { className: 'meta' },
    el('span', { className: `p-${c.priority}`, textContent: PRIO[c.priority] }));
  if (c.repos.length) meta_.append(el('span', { textContent: c.repos.join(', ') }));
  if (c.kind === 'research') meta_.prepend(el('span', { className: 'kind-research', textContent: 'Selvitys', title: 'Selvityskortti: agentti tutkii ja raportoi, ei muuta koodia' }));
  for (const d of cardDeps(c)) meta_.append(el('span', { textContent: dependencyText(d) }));
  const title = el('div', { className: 'title', textContent: c.title });
  title.addEventListener('click', () => openDetail(c.id));
  const card = el('article', { className: `card s-${c.status}` }, title, meta_);
  const turn = nextSteps?.yourTurn.find((x) => x.card === c.id && x.what !== 'Inbox');
  const ph = phaseInfo.cards[c.id];
  if (ph && !turn && ph.reason && (ph.tone === 'wait' || ph.tone === 'work')) card.append(el('div', { className: `phase tone-${ph.tone}`, textContent: `${ph.label} · ${ph.reason}` }));
  if (turn) {
    const badge = el('div', { className: 'turn', textContent: `⚑ ${turn.action}`, title: `${turn.what}${turn.detail ? `: ${turn.detail}` : ''}`, style: 'cursor:pointer' });
    badge.addEventListener('click', () => openDetail(c.id));
    card.append(badge);
  }
  if (c.brief) card.append(el('div', { className: 'brief', textContent: c.brief }));
  card.append(el('div', { className: 'more' }, ...[
    c.project ? `projektin ${c.project} suunnitelma` : '',
    c.model || c.effort ? `malli: ${[c.model, c.effort].filter(Boolean).join(' / ')}` : '',
    `luotu ${stamp(c.createdAt)}`,
    `päivitetty ${stamp(c.updatedAt)}`,
    c.id,
  ].filter(Boolean).map((t) => el('span', { textContent: t }))));
  card.append(sel);
  return card;
}

// ---- dependencies: kept in step with depsOf() / unmetDependencies() in lib/cards.js ----
const AFTER_LABEL = { done: 'toteutus', planned: 'suunnitelma' };
const AFTER_MET = { done: ['done', 'archive'], planned: ['ready', 'running', 'needs_input', 'review', 'done', 'archive'] };
/** A card's dependencies as [{ id, kind }] (the server always sends `deps`; `after` is from before a card could have several). */
const cardDeps = (c) => (Array.isArray(c.deps) ? c.deps : c.after ? [{ id: c.after, kind: c.afterKind ?? 'done' }] : []);
function dependencyText(d) {
  const dep = allCards.find((x) => x.id === d.id);
  const kind = d.kind ?? 'done';
  const met = !dep || AFTER_MET[kind].includes(dep.status);
  return `${met ? '✓ ' : ''}odottaa: ${dep ? dep.title : d.id} (${AFTER_LABEL[kind]})`;
}

/**
 * An editor for a card's dependency list: one row per card it waits for (which card, what it needs of it, remove)
 * and a button to add one. `exclude` is the card itself. `get()` gives the list as the API takes it.
 */
function depsEditor({ value = [], exclude = null, onChange = () => {} } = {}) {
  let list = value.map((d) => ({ id: d.id, kind: d.kind ?? 'done' }));
  const box = el('div', { className: 'deps-editor' });
  // A card already in the list is not offered again; an archived one only where it is already chosen.
  const choices = (current) => allCards.filter((c) => c.id !== exclude && (c.status !== 'archive' || c.id === current)
    && (c.id === current || !list.some((d) => d.id === c.id)));
  function paint() {
    const rows = list.map((d, i) => {
      const card = el('select', { ariaLabel: 'Kortti, jota odotetaan' },
        ...choices(d.id).map((c) => el('option', { value: c.id, textContent: `${c.title} (${LABELS[c.status]})`, selected: c.id === d.id })));
      card.addEventListener('change', () => { list[i].id = card.value; paint(); onChange(); });
      const kind = el('select', { ariaLabel: 'Mitä siltä odotetaan' },
        el('option', { value: 'done', textContent: 'toteutus valmis (Done)', selected: d.kind === 'done' }),
        el('option', { value: 'planned', textContent: 'suunnitelma hyväksytty', selected: d.kind === 'planned' }));
      kind.addEventListener('change', () => { list[i].kind = kind.value; onChange(); });
      const remove = el('button', { type: 'button', textContent: '×', title: 'Poista riippuvuus', ariaLabel: 'Poista riippuvuus' });
      remove.addEventListener('click', () => { list.splice(i, 1); paint(); onChange(); });
      return el('div', { className: 'dep-row' }, card, kind, remove);
    });
    const free = choices(null);
    const addBtn = el('button', { type: 'button', textContent: '+ Lisää riippuvuus', disabled: !free.length });
    addBtn.addEventListener('click', () => { list.push({ id: free[0].id, kind: 'done' }); paint(); onChange(); });
    box.replaceChildren(...rows, ...(rows.length ? [] : [el('div', { className: 'muted', textContent: 'Ei riippuvuuksia: kortin voi aloittaa heti.' })]), addBtn);
  }
  paint();
  return {
    el: box,
    get: () => list.map((d) => ({ ...d })),
    set: (v) => { list = v.map((d) => ({ id: d.id, kind: d.kind ?? 'done' })); paint(); },
  };
}

// ---- notifications: a card that starts waiting for the person ----
const WAITING = { needs_input: 'odottaa vastaustasi', review: 'on valmis katselmoitavaksi' };
const notifyBtn = document.getElementById('notify-toggle');
let notifyOn = false;
try { notifyOn = localStorage.getItem('ac_notify') === '1'; } catch { /* storage unavailable: stay off */ }
const notifySupported = 'Notification' in window;

function paintNotifyButton() {
  notifyBtn.textContent = `🔔 Ilmoitukset: ${notifyOn && notifySupported && Notification.permission === 'granted' ? 'päällä' : 'pois'}`;
  notifyBtn.classList.toggle('on', notifyOn);
}
notifyBtn.addEventListener('click', async () => {
  if (!notifySupported) return toast('Tämä selain ei tue ilmoituksia.');
  if (notifyOn) notifyOn = false;
  else if (Notification.permission === 'denied') return toast('Selain esti ilmoitukset. Salli ne osoiterivin kuvakkeesta.');
  else notifyOn = (Notification.permission === 'granted' || await Notification.requestPermission() === 'granted');
  try { localStorage.setItem('ac_notify', notifyOn ? '1' : '0'); } catch { /* storage unavailable: fine */ }
  paintNotifyButton();
});
paintNotifyButton();

function paintTitle() {
  const waiting = cards.filter((c) => c.status in WAITING).length;
  document.title = waiting ? `(${waiting}) AgentControl` : 'AgentControl';
}

/** `before` is empty on the first load, so opening the page never notifies about old cards. */
function notifyChanges(before, after) {
  if (!before.length || !notifyOn || !notifySupported || Notification.permission !== 'granted') return;
  const was = new Map(before.map((c) => [c.id, c.status]));
  for (const c of after) {
    if (!(c.status in WAITING) || !was.has(c.id) || was.get(c.id) === c.status) continue;
    const n = new Notification(c.title, { body: `Kortti ${WAITING[c.status]}`, tag: c.id });
    n.onclick = () => { window.focus(); openDetail(c.id); n.close(); };
  }
}

async function refresh(force = false) {
  try {
    const next = await api('/api/cards');
    const json = JSON.stringify(next);
    if (!force && json === lastJson) return; // skip re-render when nothing changed
    lastJson = json;
    const shown = next.filter((c) => !c.hidden); // a hidden project's cards: not listed, not notified
    notifyChanges(cards, shown);
    allCards = next;
    cards = shown;
    render();
  } catch (e) { toast(e.message); }
}

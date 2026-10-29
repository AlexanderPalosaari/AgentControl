'use strict';
// dependency graph, the card element, notifications and the board refresh.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- dependency graph: every chain of cards (after -> card) as a tree, the longest unfinished chain in bold ----
function renderGraph() {
  const box = document.getElementById('graph');
  if (document.body.dataset.view !== 'riippuvuudet') return;
  const live = cards.filter((c) => c.status !== 'archive');
  const byId = new Map(live.map((c) => [c.id, c]));
  const kids = new Map();
  for (const c of live) if (c.after && byId.has(c.after)) kids.set(c.after, [...(kids.get(c.after) ?? []), c]);
  const countBelow = (c) => (kids.get(c.id) ?? []).reduce((n, k) => n + 1 + countBelow(k), 0);
  const roots = live.filter((c) => (!c.after || !byId.has(c.after)) && kids.has(c.id));
  const alone = live.length - roots.length - roots.reduce((n, r) => n + countBelow(r), 0);
  const W = 230, H = 54, GX = 70, GY = 16;
  const NS = 'http://www.w3.org/2000/svg';
  const add = (parent, tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    parent.append(e);
    return e;
  };
  const depthOf = (c) => 1 + Math.max(0, ...(kids.get(c.id) ?? []).map(depthOf));
  const parts = roots.map((root) => {
    let row = 0;
    const nodes = [], edges = [];
    // The longest chain of cards: the path that decides when the last card can finish.
    const critical = new Set();
    for (let at = root; at; ) { critical.add(at.id); at = [...(kids.get(at.id) ?? [])].sort((a, b) => depthOf(b) - depthOf(a))[0]; }
    const place = (c, depth) => {
      const ch = (kids.get(c.id) ?? []).map((k) => place(k, depth + 1));
      const y = ch.length ? (ch[0].y + ch[ch.length - 1].y) / 2 : row++ * (H + GY);
      const n = { c, x: depth * (W + GX), y };
      nodes.push(n);
      for (const k of ch) edges.push({ from: n, to: k });
      return n;
    };
    place(root, 0);

    const width = Math.max(...nodes.map((n) => n.x)) + W + 4, height = Math.max(...nodes.map((n) => n.y)) + H + 4;
    const svg = add(document.createDocumentFragment(), 'svg', { width, height, viewBox: `0 0 ${width} ${height}` });
    for (const { from, to } of edges) {
      const x1 = from.x + W, y1 = from.y + H / 2, x2 = to.x, y2 = to.y + H / 2, mx = (x1 + x2) / 2;
      const blocking = to.c.after === from.c.id && !AFTER_MET[to.c.afterKind ?? 'done'].includes(from.c.status);
      const crit = critical.has(from.c.id) && critical.has(to.c.id) && to.c.status !== 'done';
      add(svg, 'path', { d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, class: `g-edge${blocking ? ' blocking' : ''}${crit ? ' crit' : ''}` });
    }
    for (const n of nodes) {
      const ph = phaseInfo.cards[n.c.id];
      const label = ph?.label ?? LABELS[n.c.status];
      const g = add(svg, 'g', { class: `g-node s-${n.c.status} ${ph ? `tone-${ph.tone}` : ''}`, transform: `translate(${n.x} ${n.y})`, tabindex: 0 });
      add(g, 'title', {}, `${n.c.title}\n${label}${ph?.reason ? `: ${ph.reason}` : ''}`);
      add(g, 'rect', { width: W, height: H, rx: 8 });
      add(g, 'text', { x: 12, y: 22 }, n.c.title.length > 30 ? `${n.c.title.slice(0, 29)}…` : n.c.title);
      add(g, 'text', { x: 12, y: 41, class: 'sub' }, label.length > 36 ? `${label.slice(0, 35)}…` : label);
      g.addEventListener('click', () => openDetail(n.c.id));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(n.c.id); });
    }
    const left = nodes.filter((n) => n.c.status !== 'done').length;
    return el('div', { className: 'tree' }, el('h2', { textContent: root.repos[0] ?? root.title }, el('span', { textContent: `${nodes.length} korttia, ${left} kesken` })), svg);
  });
  box.replaceChildren(
    el('div', { className: 'legend', textContent: 'Paksu viiva: pisin ketju (ratkaisee, milloin viimeinen kortti voi valmistua). Katkoviiva: riippuvuus ei ole vielä täyttynyt. Klikkaa korttia avataksesi sen.' }),
    ...(parts.length ? parts : [el('div', { className: 'muted', textContent: 'Ei korttiketjuja. Kun kortille asetetaan "aloita kortin X jälkeen", ketju näkyy tässä.' })]),
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
  if (c.after) meta_.append(el('span', { textContent: dependencyText(c) }));
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

// ---- dependencies: kept in step with unmetDependency() in lib/cards.js ----
const AFTER_LABEL = { done: 'toteutus', planned: 'suunnitelma' };
const AFTER_MET = { done: ['done', 'archive'], planned: ['ready', 'running', 'needs_input', 'review', 'done', 'archive'] };
function dependencyText(c) {
  const dep = allCards.find((x) => x.id === c.after);
  const kind = c.afterKind ?? 'done';
  const met = !dep || AFTER_MET[kind].includes(dep.status);
  return `${met ? '✓ ' : ''}odottaa: ${dep ? dep.title : c.after} (${AFTER_LABEL[kind]})`;
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

'use strict';
// "your turn", the event log, icons and the summary tiles.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- "your turn": what the board needs from the person, and what runs without them (from /api/next) ----
let nextSteps = null, nextJson = '';
/** What each card is doing right now (/api/phases): the label, who holds it (tone) and why it waits. */
let phaseInfo = { cards: {}, usage: { runsToday: 0, agentMinutes: 0 } };
const phaseLabel = (c) => phaseInfo.cards[c.id]?.label ?? LABELS[c.status];
const toneClass = (c) => (phaseInfo.cards[c.id] ? `tone-${phaseInfo.cards[c.id].tone}` : '');
async function loadNext() {
  try {
    const [next, ph] = await Promise.all([api('/api/next'), api('/api/phases')]);
    const json = JSON.stringify([next, ph]);
    if (json === nextJson) return;
    nextJson = json;
    nextSteps = next;
    phaseInfo = ph;
    renderNext();
    if (meta) render(); // the cards' "your turn" badges and phases
  } catch (e) { toast(e.message); }
}

/** A finished plan in "your turn": read it and approve it right here, without opening the card. */
async function approvePlan(cardId) {
  await api(`/api/cards/${cardId}/refine/approve`, { method: 'POST', body: { force: false } });
}
async function afterApproval() { await refresh(true); nextJson = ''; await loadNext(); }

function planItem(x) {
  const body = el('div', { className: 'pre plan-body', textContent: 'Ladataan…' });
  const details = el('details', { className: 'plan-details' }, el('summary', { textContent: 'Lue suunnitelma' }), body);
  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    try { body.textContent = (await api(`/api/cards/${x.card}/refine`)).plan || '(ei suunnitelmaa)'; }
    catch (e) { loaded = false; body.textContent = e.message; }
  });
  const approve = el('button', { type: 'button', className: 'primary', textContent: 'Hyväksy (Start work)' });
  approve.addEventListener('click', async () => {
    approve.disabled = true;
    try { await approvePlan(x.card); toast(`Suunnitelma hyväksytty: ${x.title}`); await afterApproval(); }
    catch (e) { toast(e.message); approve.disabled = false; }
  });
  const open = el('button', { type: 'button', textContent: 'Avaa kortti' });
  open.addEventListener('click', () => openDetail(x.card));
  return el('div', { className: 'next-item plan' },
    el('span', { className: 'what' }, svgIcon(ICON.question), x.what),
    el('span', { className: 'title', textContent: x.title }),
    ...(x.detail ? [el('span', { className: 'detail', textContent: x.detail })] : []),
    details,
    el('div', { className: 'row' }, approve, open));
}

async function approveAllPlans(items) {
  const ok = await confirmBox({
    title: `Hyväksytäänkö ${items.length} suunnitelmaa?`,
    text: `${items.map((x) => `· ${x.title}`).join('\n')}\n\nKortit siirtyvät Ready-tilaan ja agentit käynnistyvät, kun paikkoja on vapaana. Suunnitelmat, jotka eivät ole merkitty valmiiksi, ohitetaan.`,
    ok: 'Hyväksy kaikki',
  });
  if (!ok) return;
  const failed = [];
  for (const x of items) {
    try { await approvePlan(x.card); } catch (e) { failed.push(`${x.title}: ${e.message}`); }
  }
  toast(failed.length ? `Hyväksytty ${items.length - failed.length}/${items.length}. ${failed[0]}` : `${items.length} suunnitelmaa hyväksytty`);
  await afterApproval();
}

function renderNext() {
  const n = nextSteps;
  const box = document.getElementById('next');
  const head = el('div', { className: 'next-head' }, el('h2', { textContent: n.yourTurn.length ? `Sinun vuorosi (${n.yourTurn.length})` : 'Sinun vuorosi' }),
    el('span', { className: 'muted', textContent: n.yourTurn.length ? 'tärkein ensin, klikkaa avataksesi' : 'Mikään ei odota sinua juuri nyt.' }));
  const plans = n.yourTurn.filter((x) => x.what === 'Suunnitelma valmis' && x.card);
  if (plans.length > 1) {
    const all = el('button', { type: 'button', className: 'primary', textContent: `Hyväksy kaikki suunnitelmat (${plans.length})` });
    all.addEventListener('click', () => approveAllPlans(plans));
    head.append(all);
  }
  const items = n.yourTurn.map((x) => {
    if (x.what === 'Suunnitelma valmis' && x.card) return planItem(x);
    const b = el('button', { type: 'button', className: 'next-item' },
      el('span', { className: 'what' }, svgIcon(ICON.question), x.what),
      el('span', { className: 'title', textContent: x.title }),
      ...(x.detail ? [el('span', { className: 'detail', textContent: x.detail })] : []),
      el('span', { className: 'go', textContent: x.action }));
    b.addEventListener('click', async () => {
      if (x.attach) return openPermissionPrompt(x.card); // the row says "open the prompt": do exactly that
      return x.card && allCards.some((c) => c.id === x.card) ? openDetail(x.card) : openProjectDialog(x.project);
    });
    return b;
  });
  const line = (label, list) => (list.length ? [el('div', { className: 'next-status' }, el('b', { textContent: `${label}: ` }), list.join(' · '))] : []);
  box.replaceChildren(head, el('div', { className: 'next-grid' }, ...items), ...line('Työssä nyt', n.working), ...line('Odottaa', n.waiting));
}

// ---- event log: a live stream of what happens, kept on disk across restarts (/api/events/stream) ----
const KIND_LABEL = { card: 'kortti', agent: 'agentti', refine: 'tarkennus', review: 'katselmointi', project: 'projekti', ohjaaja: 'ohjaaja', pr: 'PR', error: 'virhe', app: 'sovellus' };
const logPane = document.getElementById('logpane');
const logList = document.getElementById('log-list');
const logFilter = document.getElementById('log-filter');
let logStream = null, logEntries = [], lastLogDay = '';

const pad2 = (n) => String(n).padStart(2, '0');
function logMatches(e) {
  if ((e.project && projects.some((p) => p.name === e.project && p.hidden)) || (e.card && allCards.some((c) => c.id === e.card && c.hidden))) return false; // a hidden project
  const f = logFilter.value;
  if (!f) return true;
  if (f === '!problems') return e.level === 'error' || e.level === 'warn';
  return f.split(',').includes(e.kind);
}
function logLine(e) {
  const d = new Date(e.t);
  const day = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  const parts = [];
  if (day !== lastLogDay) { lastLogDay = day; parts.push(el('div', { className: 'log-day', textContent: day })); }
  const link = (e.card && allCards.some((c) => c.id === e.card)) || (e.project && projects.some((p) => p.name === e.project));
  const row = el('div', { className: `log-line ${e.level ?? ''} ${link ? 'link' : ''}`, title: link ? 'Avaa' : '' },
    el('span', { className: 'tm', textContent: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` }),
    el('span', { className: 'kind', textContent: KIND_LABEL[e.kind] ?? e.kind }),
    el('span', { className: 'tx', textContent: e.text }));
  if (link) row.addEventListener('click', () => (e.card && allCards.some((c) => c.id === e.card) ? openDetail(e.card) : openProjectDialog(e.project)));
  parts.push(row);
  return parts;
}
function paintLog() {
  lastLogDay = '';
  logList.replaceChildren(...logEntries.filter(logMatches).flatMap(logLine));
  logList.scrollTop = logList.scrollHeight;
}
function addLogEntry(e) {
  logEntries.push(e);
  if (logEntries.length > 1500) logEntries = logEntries.slice(-1000);
  if (!logMatches(e)) return;
  const atBottom = logList.scrollTop + logList.clientHeight >= logList.scrollHeight - 8;
  logList.append(...logLine(e));
  if (atBottom) logList.scrollTop = logList.scrollHeight;
}
function setLogOpen(open) {
  logPane.hidden = !open;
  document.getElementById('log-toggle').classList.toggle('on', open);
  try { localStorage.setItem('ac_log', open ? '1' : '0'); } catch { /* not remembered: fine */ }
  if (open && !logStream) {
    logEntries = [];
    logList.replaceChildren();
    logStream = new EventSource('/api/events/stream?limit=500'); // the backlog first, then live entries
    logStream.onmessage = (ev) => addLogEntry(JSON.parse(ev.data));
  } else if (!open && logStream) {
    logStream.close();
    logStream = null;
  }
}
document.getElementById('log-toggle').addEventListener('click', () => setLogOpen(logPane.hidden));
document.getElementById('log-close').addEventListener('click', () => setLogOpen(false));
logFilter.addEventListener('change', paintLog);

/** Opens the agent's permission prompt in its own terminal window (the only place it can be answered). */
async function openPermissionPrompt(cardId) {
  try {
    await api(`/api/cards/${cardId}/run/attach`, { method: 'POST', body: {} });
    await confirmBox({
      title: 'Lupakysely aukesi terminaaliin',
      text: 'Agentin lupakysely aukesi omaan terminaali-ikkunaansa (katso tehtäväpalkista, jos se jäi tämän ikkunan taakse).\n\nValitse siellä numero: 1 = kyllä, 3 = kyllä ja auto-tila (agentti ei kysy tavallisista komennoista enää), 4 = ei. Sulje terminaali, kun agentti jatkaa.',
      ok: 'Selvä',
    });
  } catch (e) { toast(e.message); }
}

/** Stroke icons (24x24 paths), drawn next to labels so a state is never told by colour alone. */
const ICON = {
  play: 'M8 5l11 7-11 7z', question: 'M9.5 9a2.6 2.6 0 1 1 3.9 2.2c-.9.5-1.4 1.1-1.4 2.3M12 17.5v.5', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  queue: 'M5 12h14M13 6l6 6-6 6', lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z', warn: 'M12 9v4.5M12 17v.5M3 20L12 4l9 16z', pencil: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3', check: 'M5 12.5l4.5 4.5L19 7',
};
const STATUS_ICON = { running: ICON.play, needs_input: ICON.question, review: ICON.eye, ready: ICON.queue, refining: ICON.pencil, inbox: ICON.queue, done: ICON.check, archive: ICON.check };
function svgIcon(path, size = 16, stroke = 2) {
  const s = document.createElement('span');
  s.style.display = 'inline-flex';
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"></path></svg>`;
  return s;
}

const STAT_TILES = [['running', 'Käynnissä', 'agenttia'], ['needs_input', 'Odottaa sinua', 'kysymys, lupa tai suunnitelma'], ['review', 'Katselmoitavana', 'muutosta'], ['ready', 'Valmiina jonossa', 'korttia']];
const WEEKDAYS = ['sunnuntai', 'maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai'];
function renderStats() {
  const open = cards.filter((c) => c.status !== 'archive').length;
  const today = new Date();
  document.getElementById('sub').textContent = `${WEEKDAYS[today.getDay()]} ${today.getDate()}.${today.getMonth() + 1}. · ${open} korttia työn alla${phaseInfo.usage.runsToday ? ` · tänään ${phaseInfo.usage.runsToday} ajoa, agenttiaikaa ${phaseInfo.usage.agentMinutes >= 60 ? `${Math.floor(phaseInfo.usage.agentMinutes / 60)} h ${phaseInfo.usage.agentMinutes % 60} min` : `${phaseInfo.usage.agentMinutes} min`}` : ''}${usageData && workTokens(usageData.today) ? ` · tänään ${fmtTokens(workTokens(usageData.today))} tokenia` : ''}`;
  document.getElementById('stats').replaceChildren(...STAT_TILES.map(([status, label, note]) =>
    // "Odottaa sinua" is the same count as the "Sinun vuorosi" list (it also holds plans to approve in Refining,
    // questions from the refiner, projects), not only the Needs input column.
    el('div', { className: `tile s-${status}` }, el('span', { className: 'lab' }, svgIcon(STATUS_ICON[status]), label),
      el('span', { className: 'val' }, el('b', { textContent: status === 'needs_input' && nextSteps ? nextSteps.yourTurn.length : cards.filter((c) => c.status === status).length }), el('i', { textContent: note })))));
}

/** "24.10. 23:04": spelled out, so the result does not depend on the machine's locale settings. */
function stamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()}.${d.getMonth() + 1}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

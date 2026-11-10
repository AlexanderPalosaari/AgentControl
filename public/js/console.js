'use strict';
// #/konsoli: every working agent's conversation live, side by side (what `claude attach <id>` would show).
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

const KIND_NAME = { agent: 'Toteutus', research: 'Selvitys', refine: 'Tarkennus' };
const con = {
  es: null,
  panes: new Map(),     // worker key -> { worker, el, log, status, ended }
  showThinking: true,
  showOutput: false,
  wide: null,           // the key of the pane shown full width
};
try {
  con.showThinking = localStorage.getItem('ac_con_thinking') !== '0';
  con.showOutput = localStorage.getItem('ac_con_output') === '1';
} catch { /* storage unavailable: defaults */ }

const conInView = () => document.body.dataset.view === 'konsoli';

/** One line of the log. Refiner lines have the same kinds as an agent's, minus thinking and output. */
function conLine(e) {
  const time = e.t ? stamp(e.t).split(' ')[1] ?? '' : '';
  let cls = e.kind, text;
  if (e.kind === 'text') text = e.text;
  else if (e.kind === 'thinking') text = e.text;
  else if (e.kind === 'tool') text = `▸ ${e.name}${e.summary ? `  ${e.summary}` : ''}`;
  else if (e.kind === 'output') { text = e.text || '(ei tulostetta)'; if (e.error) cls += ' err'; }
  else if (e.kind === 'user') text = `› ${e.text}`;
  else if (e.kind === 'turn') text = `— vuoro ${e.turn} —`;
  else if (e.kind === 'result') text = e.ok === false ? 'vuoro päättyi virheeseen' : 'vuoro valmis';
  else if (e.kind === 'error') { text = `virhe: ${e.message}`; cls += ' err'; }
  else return null;
  if (e.sub) cls += ' sub';
  return el('div', { className: `cl ${cls}` }, el('span', { className: 'ct', textContent: time }), el('span', { className: 'cx', textContent: text }));
}

function conAppend(key, entries) {
  const pane = con.panes.get(key);
  if (!pane) return;
  const box = pane.log;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  for (const e of entries) {
    const line = conLine(e);
    if (line) box.append(line);
  }
  while (box.childElementCount > 1500) box.firstElementChild.remove(); // a long session: keep the page light
  if (atBottom) box.scrollTop = box.scrollHeight;
  pane.el.classList.add('fresh');
  clearTimeout(pane.freshTimer);
  pane.freshTimer = setTimeout(() => pane.el.classList.remove('fresh'), 1500);
}

function conStatusText(w, ended) {
  if (ended) return 'päättynyt';
  if (w.waitingFor) return `odottaa lupaa: ${w.waitingFor}`;
  if (w.state === 'needs_input') return 'odottaa sinua';
  if (w.state === 'reviewing') return 'katselmoidaan';
  return w.startedAt ? `työskentelee · ${elapsed(w.startedAt)}` : 'työskentelee';
}

function conPane(w) {
  const status = el('span', { className: 'cstatus' });
  const log = el('div', { className: 'clog', role: 'log', ariaLive: 'off' });
  const title = el('button', { type: 'button', className: 'ctitle', textContent: w.title, title: 'Avaa kortti' });
  title.addEventListener('click', () => openDetail(w.card));
  const tools = el('div', { className: 'ctools' });
  if (w.agentId) {
    const cmd = `claude attach ${w.agentId}`;
    const copy = el('button', { type: 'button', className: 'mono', textContent: cmd, title: 'Kopioi komento leikepöydälle' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(cmd); toast('Komento kopioitu'); } catch { toast(cmd); }
    });
    const term = el('button', { type: 'button', textContent: 'Avaa terminaalissa', title: 'Avaa agentti omaan konsoli-ikkunaan, jossa voit myös vastata lupakyselyihin' });
    term.addEventListener('click', () => openPermissionPrompt(w.card));
    tools.append(copy, term);
  }
  const wide = el('button', { type: 'button', textContent: '⤢', title: 'Leveä näkymä', ariaLabel: 'Leveä näkymä' });
  wide.addEventListener('click', () => { con.wide = con.wide === w.key ? null : w.key; conLayout(); });
  tools.append(wide);
  const head = el('div', { className: 'chead' },
    el('span', { className: `ckind k-${w.kind}`, textContent: KIND_NAME[w.kind] ?? w.kind }), title, status, tools);
  const pane = el('section', { className: 'cpane', ariaLabel: `${KIND_NAME[w.kind] ?? ''}: ${w.title}` }, head, log);
  return { worker: w, el: pane, log, status, ended: false };
}

function conLayout() {
  const grid = document.getElementById('con-grid');
  const live = [...con.panes.values()];
  for (const p of live) {
    p.el.classList.toggle('wide', con.wide === p.worker.key);
    p.el.classList.toggle('ended', p.ended);
    p.status.textContent = conStatusText(p.worker, p.ended);
    p.status.classList.toggle('warn', Boolean(p.worker.waitingFor) || p.worker.state === 'needs_input');
  }
  const working = live.filter((p) => !p.ended).length;
  document.getElementById('con-count').textContent = working ? `${working} työssä` : 'Kukaan ei ole töissä juuri nyt';
  document.getElementById('con-clear').hidden = !live.some((p) => p.ended);
  document.getElementById('con-empty').hidden = live.length > 0;
  // Working panes first, in the order they appeared; ended ones after them.
  grid.replaceChildren(...live.filter((p) => !p.ended).map((p) => p.el), ...live.filter((p) => p.ended).map((p) => p.el));
}

function conWorkers(list) {
  const keys = new Set(list.map((w) => w.key));
  for (const w of list) {
    const pane = con.panes.get(w.key);
    if (pane) { pane.worker = w; pane.ended = false; }
    else con.panes.set(w.key, conPane(w));
  }
  for (const [key, p] of con.panes) if (!keys.has(key)) p.ended = true; // kept until "Poista päättyneet", so the end stays readable
  conLayout();
}

function conMessage(msg) {
  if (msg.type === 'workers') conWorkers(msg.workers);
  else if (msg.type === 'backlog') { const p = con.panes.get(msg.key); if (p) { p.log.replaceChildren(); conAppend(msg.key, msg.entries); } }
  else if (msg.type === 'entry') conAppend(msg.key, [msg.entry]);
}

function conPaintFilters() {
  const view = document.getElementById('console');
  view.classList.toggle('no-thinking', !con.showThinking);
  view.classList.toggle('no-output', !con.showOutput);
  document.getElementById('con-thinking').checked = con.showThinking;
  document.getElementById('con-output').checked = con.showOutput;
}

function conConnect() {
  if (con.es) return;
  con.es = new EventSource('/api/console/stream');
  con.es.onmessage = (ev) => { try { conMessage(JSON.parse(ev.data)); } catch { /* a bad line: skip */ } };
  con.es.onerror = () => { document.getElementById('con-count').textContent = 'Yhteys katkesi, yhdistetään uudelleen…'; };
}
function conDisconnect() {
  con.es?.close();
  con.es = null;
}

// The stream runs only while the view is open (and the tab visible): the server reads transcripts only then.
function conSync() {
  if (conInView() && !document.hidden) conConnect();
  else conDisconnect();
}
window.addEventListener('hashchange', conSync);
document.addEventListener('visibilitychange', conSync);
setInterval(() => { if (conInView()) for (const p of con.panes.values()) p.status.textContent = conStatusText(p.worker, p.ended); }, 30_000);

document.getElementById('con-thinking').addEventListener('change', (ev) => {
  con.showThinking = ev.target.checked;
  try { localStorage.setItem('ac_con_thinking', con.showThinking ? '1' : '0'); } catch { /* fine */ }
  conPaintFilters();
});
document.getElementById('con-output').addEventListener('change', (ev) => {
  con.showOutput = ev.target.checked;
  try { localStorage.setItem('ac_con_output', con.showOutput ? '1' : '0'); } catch { /* fine */ }
  conPaintFilters();
});
document.getElementById('con-clear').addEventListener('click', () => {
  for (const [key, p] of con.panes) if (p.ended) con.panes.delete(key);
  if (con.wide && !con.panes.has(con.wide)) con.wide = null;
  conLayout();
});
conPaintFilters();
conSync();

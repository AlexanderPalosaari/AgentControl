'use strict';
// shared helpers: labels, api(), toast, confirmBox, el(), render.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

const LABELS = {
  inbox: 'Inbox', refining: 'Refining', ready: 'Ready', running: 'Running',
  needs_input: 'Needs input', review: 'Review', done: 'Done', archive: 'Archive',
};
const PRIO = { low: 'matala', normal: 'normaali', high: 'korkea' };
const TIPS = {
  inbox: 'Uudet tehtävät. Kirjoita kuvaus, klikkaa korttia ja paina "Aloita tarkennus".',
  refining: 'Tekoäly lukee koodin, kysyy tarkennuksia ja kirjoittaa suunnitelman. Vastaat kysymyksiin ja painat lopuksi "Start work".',
  ready: 'Valmis aloitettavaksi. Ohjelma käynnistää agentin itse heti kun on vapaa paikka (näkyy yläreunassa "Ajossa").',
  running: 'Agentti tekee työtä omassa kansiossaan. Myös automaattinen katselmointi tapahtuu täällä.',
  needs_input: 'Agentti kysyy sinulta jotain tai jäi jumiin. Avaa kortti ja vastaa tai pysäytä.',
  review: 'Työ on valmis. Lue raportti ja katselmoinnin löydökset, ja luo sitten pull request.',
  done: 'Pull request on yhdistetty. Työ on valmis.',
  archive: 'Vanhat kortit. Siirrä tänne itse, kun et enää tarvitse korttia.',
};
let meta = null;
let cards = []; // what the views list: the cards of hidden projects left out
let allCards = []; // every card, for finding one by id (a hidden project's card still opens from its project)
let lastJson = '';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => (t.style.display = 'none'), 4000);
}

/**
 * Every confirmation: a popup with OK and Cancel. Resolves to false on Cancel/Esc, true on OK, or
 * { checked } when the popup has a checkbox (e.g. "delete the folder too"). Popups queue, one at a time.
 */
let confirmQueue = Promise.resolve();
function confirmBox({ title = 'Vahvista', text = '', ok = 'OK', danger = false, checkbox = null }) {
  const shown = confirmQueue.then(() => new Promise((resolve) => {
    const box = document.getElementById('cdlg');
    const okBtn = document.getElementById('c-ok');
    const check = document.getElementById('c-check');
    const cb = check.querySelector('input');
    document.getElementById('c-title').textContent = title;
    document.getElementById('c-text').textContent = text;
    check.classList.toggle('on', Boolean(checkbox));
    check.querySelector('span').textContent = checkbox ?? '';
    cb.checked = false;
    okBtn.textContent = ok;
    okBtn.className = danger ? 'danger' : 'primary';
    let answer = false;
    const finish = () => { okBtn.onclick = null; document.getElementById('c-cancel').onclick = null; resolve(answer); };
    okBtn.onclick = () => { answer = checkbox ? { checked: cb.checked } : true; box.close(); };
    document.getElementById('c-cancel').onclick = () => box.close();
    box.addEventListener('close', finish, { once: true }); // Esc closes too, as a Cancel
    box.showModal();
    (danger ? document.getElementById('c-cancel') : okBtn).focus(); // a destructive OK is never the default
  }));
  confirmQueue = shown.catch(() => {});
  return shown;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) e.append(c);
  return e;
}

function render() {
  const board = document.getElementById('board');
  const scroll = board.scrollLeft;
  board.replaceChildren(...meta.statuses.map((status) => {
    const inCol = cards.filter((c) => c.status === status);
    const col = el('section', { className: 'col' },
      el('h2', { title: TIPS[status] ?? '', className: `s-${status}` }, el('span', { className: 'dot' }), el('span', { textContent: LABELS[status] }), el('span', { className: 'count', textContent: inCol.length })));
    for (const c of inCol) col.append(renderCard(c));
    return col;
  }));
  board.scrollLeft = scroll;
  renderStats();
  renderGraph();
  renderAgents();
  renderChanges();
  paintTitle();
}

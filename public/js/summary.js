'use strict';
// "Päivän yhteenveto": what got done on a day, what waits for review and what is still under way.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

const sumDlg = document.getElementById('sumdlg');
const sumDay = document.getElementById('sum-day');
let sumData = null;

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const SUM_FACTS = [
  ['done', 'valmistui'], ['review', 'katselmoitavana'], ['created', 'uutta korttia'], ['agentsStarted', 'agenttiajoa'],
  ['refined', 'tarkennusta'], ['research', 'selvitystä'], ['merged', 'yhdistetty projektiin'], ['prsOpened', 'PR avattu'], ['prsMerged', 'PR yhdistetty'],
];

function sumCardRow(x, extra = '') {
  const title = el('button', { type: 'button', className: 'sum-title', textContent: x.title });
  title.addEventListener('click', () => { sumDlg.close(); openDetail(x.id); });
  return el('li', {}, ...(x.kind === 'research' ? [el('span', { className: 'kind-research', textContent: 'Selvitys ' })] : []), title,
    ...(x.what ? [el('div', { className: 'muted', textContent: x.what })] : []), ...(extra ? [el('span', { className: 'muted', textContent: ` · ${extra}` })] : []));
}

function renderSummary(s) {
  const body = document.getElementById('sum-body');
  if (s.quiet) return body.replaceChildren(el('div', { className: 'muted sum-empty', textContent: 'Tältä päivältä ei ole tapahtumia.' }));
  const facts = SUM_FACTS.filter(([k]) => s.counts[k]).map(([k, label]) => el('div', { className: 'sum-fact' }, el('b', { textContent: s.counts[k] }), el('span', { textContent: label })));
  const tok = s.tokens.input + s.tokens.output;
  if (tok) facts.push(el('div', { className: 'sum-fact' }, el('b', { textContent: fmtTokens(tok) }), el('span', { textContent: 'tokenia' })));
  const section = (title, items) => (items.length ? [el('h3', { textContent: title }), el('ul', { className: 'sum-list' }, ...items)] : []);
  body.replaceChildren(
    el('div', { className: 'sum-facts' }, ...(facts.length ? facts : [el('div', { className: 'muted', textContent: 'Ei valmistuneita töitä.' })])),
    ...section('Valmistui', s.done.map((x) => sumCardRow(x))),
    ...section('Odottaa katselmointia', s.review.map((x) => sumCardRow(x))),
    ...section('Kesken', s.inProgress.map((x) => sumCardRow(x, x.statusName))),
    ...section('Uudet kortit', s.created.map((x) => sumCardRow(x))),
    ...section(`Virheet (${s.counts.errors})`, s.problems.map((p) => el('li', { className: 'err', textContent: `${stamp(p.t).split(' ')[1]} ${p.text.split('\n')[0].slice(0, 200)}` }))));
}

async function loadSummary() {
  const day = sumDay.value || isoDay(new Date());
  document.getElementById('sum-next').disabled = day >= isoDay(new Date());
  document.getElementById('sum-body').replaceChildren(el('div', { className: 'muted', textContent: 'Kootaan…' }));
  try {
    sumData = await api(`/api/summary?day=${day}`);
    if (sumDay.value === day) renderSummary(sumData);
  } catch (e) {
    sumData = null;
    document.getElementById('sum-body').replaceChildren(el('div', { className: 'err', textContent: e.message }));
  }
}

function shiftDay(n) {
  const d = new Date(`${sumDay.value || isoDay(new Date())}T12:00:00`);
  d.setDate(d.getDate() + n);
  const next = isoDay(d);
  if (next > isoDay(new Date())) return;
  sumDay.value = next;
  loadSummary();
}

function openSummary() {
  sumDay.max = isoDay(new Date());
  sumDay.value = isoDay(new Date());
  sumDlg.showModal();
  loadSummary();
}

document.getElementById('day-summary').addEventListener('click', openSummary);
document.getElementById('sum-close').addEventListener('click', () => sumDlg.close());
document.getElementById('sum-prev').addEventListener('click', () => shiftDay(-1));
document.getElementById('sum-next').addEventListener('click', () => shiftDay(1));
sumDay.addEventListener('change', loadSummary);
document.getElementById('sum-copy').addEventListener('click', async () => {
  if (!sumData) return;
  try { await navigator.clipboard.writeText(sumData.markdown); toast('Yhteenveto kopioitu leikepöydälle'); }
  catch { toast('Kopiointi ei onnistunut'); }
});
{ // a click on the backdrop closes it, like the other dialogs
  let pressed = false;
  sumDlg.addEventListener('mousedown', (ev) => { pressed = ev.target === sumDlg; });
  sumDlg.addEventListener('click', (ev) => { if (ev.target === sumDlg && pressed) sumDlg.close(); });
}

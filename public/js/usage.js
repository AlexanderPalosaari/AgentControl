'use strict';
// token use: what the work has spent, counted in tokens (/api/usage). Shown on the settings page, in the summary line and on cards.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

let usageData = null, usageJson = '', usageLoadedAt = 0;

/** 1234 -> "1,2 k", 2500000 -> "2,5 M": spelled out here so the result does not depend on the machine's locale. */
function fmtTokens(n) {
  n = Number(n) || 0;
  const short = (v, unit) => `${(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toString().replace('.', ',')} ${unit}`;
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'k');
  return String(Math.round(n));
}

/** Tokens that count as "work": what was read fresh, written to the cache and produced. Reads from the cache are listed apart. */
const workTokens = (u) => (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0);
const usageText = (u) => `${fmtTokens(workTokens(u))} (syöte ${fmtTokens(u?.input)} + välimuistiin ${fmtTokens(u?.cacheWrite)} + tuloste ${fmtTokens(u?.output)}), välimuistista luettu ${fmtTokens(u?.cacheRead)}`;

const USAGE_KINDS = { agent: 'Toteutusagentit', review: 'Automaattinen katselmointi', refine: 'Tarkennus', planner: 'Projektien suunnittelu', explore: 'Koodin tutkiminen', audit: 'Haavoittuvuustarkastus', orchestrator: 'Ohjaaja', voice: 'Puheen tulkinta', sandbox: 'Sandbox' };

/** At most every 15 s (the summary reads the whole ledger); `force` after something that certainly spent tokens. */
async function loadUsage(force = false) {
  if (document.hidden || (!force && Date.now() - usageLoadedAt < 15_000)) return;
  usageLoadedAt = Date.now();
  try {
    const next = await api('/api/usage');
    const json = JSON.stringify(next);
    if (json === usageJson) return;
    usageJson = json;
    usageData = next;
    renderStats();
    renderUsage();
    if (openId) { const c = allCards.find((x) => x.id === openId); if (c) setDetailMeta(c); }
  } catch { /* the next tick tries again */ }
}

/** "Tokenit: 1,2 M" for one card, from the ledger; empty when it has spent none. */
function cardTokens(id) {
  const u = usageData?.byCard?.[id];
  return u && workTokens(u) ? ` · ${fmtTokens(workTokens(u))} tokenia` : '';
}

function renderUsage() {
  const box = document.getElementById('set-usage');
  if (!box || !usageData) return;
  const row = (title, help, control) => el('div', { className: 'srow' }, el('div', {}, el('b', { textContent: title }), el('span', { className: 'muted', textContent: help })), control);
  const mono = (t) => el('span', { className: 'mono', textContent: t });

  const kinds = Object.entries(usageData.byKind).sort((a, b) => workTokens(b[1]) - workTokens(a[1]));
  const titleOf = (id) => allCards.find((c) => c.id === id)?.title ?? id;
  const topCards = Object.entries(usageData.byCard).sort((a, b) => workTokens(b[1]) - workTokens(a[1])).slice(0, 8);
  const topProjects = Object.entries(usageData.byProject).sort((a, b) => workTokens(b[1]) - workTokens(a[1]));
  const days = usageData.byDay;
  const peak = Math.max(1, ...days.map(workTokens));
  const bars = el('div', { className: 'usage-days', role: 'img', ariaLabel: `Tokenit päivittäin, ${days.length} päivää` },
    ...days.map((d) => el('div', { className: 'usage-day', title: `${d.day}: ${usageText(d)}` },
      el('span', { className: 'usage-bar', style: `height:${Math.max(2, Math.round(workTokens(d) / peak * 100))}%` }),
      el('i', { textContent: d.day.slice(8) }))));

  box.replaceChildren(
    el('h2', { textContent: 'Tokenien käyttö' }),
    el('p', { className: 'muted', textContent: 'Lasketaan tokeneina, ei euroina tai dollareina. "Työtä" = tuore syöte + välimuistiin kirjoitettu + tuloste; välimuistista luettu on erikseen, koska sitä on paljon ja se on halpaa. Agenttien käyttö luetaan niiden istuntotiedostoista.' }),
    row('Tänään', usageText(usageData.today), mono(fmtTokens(workTokens(usageData.today)))),
    row('Yhteensä', usageText(usageData.total), mono(fmtTokens(workTokens(usageData.total)))),
    ...(days.length ? [el('div', { className: 'srow' }, bars)] : []),
    ...kinds.map(([kind, u]) => row(USAGE_KINDS[kind] ?? kind, usageText(u), mono(fmtTokens(workTokens(u))))),
    ...(topProjects.length ? [el('h3', { className: 'usage-h', textContent: 'Projektit' }), ...topProjects.map(([name, u]) => row(name, usageText(u), mono(fmtTokens(workTokens(u)))))] : []),
    ...(topCards.length ? [el('h3', { className: 'usage-h', textContent: 'Eniten käyttäneet kortit' }), ...topCards.map(([id, u]) => row(titleOf(id), usageText(u), mono(fmtTokens(workTokens(u)))))] : []),
    ...(!kinds.length ? [el('div', { className: 'state', textContent: 'Ei vielä kirjattua käyttöä. Se alkaa kertyä kun agentit, tarkentajat tai ohjaaja ajavat.' })] : []));
}

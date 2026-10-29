'use strict';
// the settings page.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- settings: the dispatcher's limits (saved on the server), the projects' models, this browser's voice and notification switches ----
let settingsData = null, settingsJson = '', settingsSaved = '';

async function loadSettings() {
  if (document.hidden || document.body.dataset.view !== 'asetukset') return;
  try {
    const next = await api('/api/settings');
    const json = JSON.stringify(next);
    if (json === settingsJson) return;
    settingsJson = json;
    settingsData = next;
    renderSettings();
  } catch { /* the next tick tries again */ }
}

async function saveSetting(patch) {
  try {
    settingsData = await api('/api/settings', { method: 'POST', body: patch });
    settingsJson = JSON.stringify(settingsData);
    settingsSaved = 'Tallennettu. Käynnissä oleviin agentteihin muutos ei vaikuta.';
  } catch (e) { toast(e.message); settingsJson = ''; settingsSaved = ''; }
  renderSettings();
  loadDispatcher();
}

function renderSettings() {
  if (!settingsData) return;
  if (document.activeElement?.closest?.('#set-runner') && document.activeElement.tagName === 'INPUT') return; // do not pull the field away while typing
  const r = settingsData.runner;
  const row = (title, help, control) => el('div', { className: 'srow' }, el('div', {}, el('b', { textContent: title }), el('span', { className: 'muted', textContent: help })), control);
  const stepper = (title, help, key, min, max) => {
    const step = (d, label) => { const b = el('button', { type: 'button', textContent: d > 0 ? '+' : '−', ariaLabel: `${label}: ${title}` }); b.addEventListener('click', () => saveSetting({ [key]: Math.min(max, Math.max(min, r[key] + d)) })); return b; };
    return row(title, help, el('div', { className: 'stepper' }, step(-1, 'Vähennä'), el('span', { className: 'mono', textContent: String(r[key]) }), step(1, 'Lisää')));
  };
  const hour = (key, label) => {
    const input = el('input', { type: 'number', min: 0, max: 23, value: r[key], ariaLabel: label });
    input.addEventListener('change', () => saveSetting({ [key]: Number(input.value) }));
    return input;
  };
  const pause = el('button', { type: 'button', role: 'switch', ariaChecked: String(r.enabled), textContent: r.enabled ? 'Käynnissä' : 'Tauolla' });
  pause.addEventListener('click', async () => { await api('/api/dispatcher', { method: 'POST', body: { enabled: !r.enabled } }); settingsJson = ''; loadSettings(); loadDispatcher(); });
  document.getElementById('set-runner').replaceChildren(
    el('h2', { textContent: 'Rinnakkaisuus' }),
    el('p', { className: 'muted', textContent: `Montako agenttia saa olla työssä yhtä aikaa. Ylimenevät kortit jonottavat. Nyt ajossa ${r.running}, voimassa ${r.night ? 'yöraja' : 'päiväraja'} ${r.limit}.` }),
    stepper('Päiväraja', 'Samanaikaisia agentteja päivällä.', 'dayLimit', 1, 20),
    stepper('Yöraja', 'Samanaikaisia agentteja yöllä.', 'nightLimit', 1, 20),
    row('Yöajan aikaväli', 'Tuntia 0–23. Tänä aikana käytetään yörajaa.', el('div', { className: 'stepper' }, hour('nightStart', 'Yö alkaa (tunti)'), '–', hour('nightEnd', 'Yö päättyy (tunti)'))),
    row('Agenttien ajo', 'Tauolla ollessa uusia agentteja ei käynnistetä. Käynnissä olevat jatkavat.', pause),
    ...(settingsSaved ? [el('div', { className: 'state', role: 'status', textContent: settingsSaved })] : []));

  document.getElementById('set-projects').replaceChildren(
    el('h2', { textContent: 'Projektit ja mallit' }),
    el('p', { className: 'muted', textContent: `Repojen kansio: ${settingsData.reposRoot}. Malli ja effort valitaan projektikohtaisesti.` }),
    ...(projects.length ? projects.map((p) => {
      const b = el('button', { type: 'button', textContent: 'Muokkaa' });
      b.addEventListener('click', () => openProjectDialog(p.name));
      return row(p.name, [scLabel(p), modelLabel(p) || 'oletusmalli', p.path].filter(Boolean).join(' · '), b);
    }) : [el('div', { className: 'state', textContent: 'Ei projekteja. Luo ensimmäinen sivupalkin "+ Uusi projekti" -painikkeella.' })]));

  document.getElementById('set-keep').replaceChildren(
    el('h2', { textContent: 'Käynnistysasetukset' }),
    el('p', { className: 'muted', textContent: 'Nämä luetaan ympäristömuuttujista palvelimen käynnistyessä. Niiden muuttaminen vaatii uudelleenkäynnistyksen.' }),
    row('Automaattinen katselmointi', 'AGENTCONTROL_REVIEW = off | low | medium | high, AGENTCONTROL_SECURITY_REVIEW=1 lisää tietoturvakatselmoinnin.', el('span', { className: 'mono', textContent: settingsData.reviewEnabled ? 'päällä' : 'pois' })),
    row('Arkistoitujen korttien live-loki', 'AGENTCONTROL_ARCHIVE_DAYS. Commitit, raportit ja kustannukset säilyvät aina.', el('span', { className: 'mono', textContent: settingsData.archiveDays > 0 ? `${settingsData.archiveDays} pv` : 'ei poistoa' })),
    row('Agenttien oletusmalli ja effort', 'AGENTCONTROL_AGENT_MODEL ja AGENTCONTROL_AGENT_EFFORT. Projektin oma valinta ohittaa nämä.', el('span', { className: 'muted', textContent: 'katso Projektit' })));
}

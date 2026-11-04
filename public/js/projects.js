'use strict';
// projects: new repository, source control, plan and task cards.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- projects: a new repository, where its source control lives, then a plan and task cards ----
const pdlg = document.getElementById('pdlg');
let projects = [], projectsJson = '', openProject = null, openProjectData = null, projectJson = '', projectTimer = null;
let projectBranches = null; // { name, repos }: where the open project's repositories stand, read when it opens and on "Päivitä"
const STEP_HINT = { remote: 'GitHub kesken', existing: '', describe: 'kuvaus puuttuu', planning: 'suunnitellaan…', review: 'suunnitelma valmis', done: '' };
const scLabel = (p) => p.sourceControl.kind === 'local' ? 'paikallinen repo' : p.sourceControl.kind === 'remote' ? 'etärepo' : p.sourceControl.pushed ? `GitHub ${p.sourceControl.fullName}` : 'GitHub (kesken)';
const modelLabel = (p) => [p.model, p.effort].filter(Boolean).join(' / ');
const setPError = (msg) => { document.getElementById('p-error').textContent = msg; };

async function loadProjects() {
  try {
    const next = await api('/api/projects');
    const json = JSON.stringify(next);
    if (json === projectsJson) return;
    projectsJson = json;
    projects = next;
    renderSettings();
    document.getElementById('projects-box').style.display = projects.length ? '' : 'none';
    const listed = [...projects].sort((a, b) => Number(a.hidden) - Number(b.hidden)); // the hidden ones last, so they never push a shown one out
    document.getElementById('projects').replaceChildren(...listed.slice(0, 8).map((p) => {
      const b = el('button', { type: 'button', className: `proj${p.hidden ? ' hid' : ''}`, title: `Lähdekoodi: ${p.path}\n${[scLabel(p), modelLabel(p), STEP_HINT[p.step]].filter(Boolean).join(' · ')}${p.activeAgents > 0 ? `\n${p.activeAgents} agenttia työstää projektia juuri nyt` : ''}${p.hidden ? '\nPiilotettu: kortit eivät näy muualla. Palauta näkyviin projektin asetuksista.' : ''}` },
        el('span', { className: `dot${p.activeAgents > 0 ? ' on' : ''}` }), el('span', { className: 'nm', textContent: p.name }),
        ...(p.hidden ? [el('span', { className: 'hd', textContent: 'piilotettu' })] : []),
        el('span', { className: 'ct', textContent: p.activeAgents > 0 ? String(p.activeAgents) : '' }));
      b.addEventListener('click', () => openProjectDialog(p.name));
      return b;
    }));
  } catch (e) { toast(e.message); }
}

function githubFields() {
  let saved = '';
  try { saved = localStorage.getItem('ac_gh_owner') ?? ''; } catch { /* storage unavailable: start empty */ }
  const owner = el('input', { type: 'text', placeholder: 'oma tili', maxLength: 39, value: saved, autocomplete: 'off' });
  const priv = el('input', { type: 'checkbox', checked: true });
  const node = el('div', {}, el('label', { className: 'f', textContent: 'GitHub-omistaja (käyttäjä tai organisaatio)' }), owner,
    el('label', { className: 'inline' }, priv, 'Yksityinen repo'));
  const value = () => {
    try { localStorage.setItem('ac_gh_owner', owner.value.trim()); } catch { /* not remembered: fine */ }
    return { kind: 'github', owner: owner.value.trim(), private: priv.checked };
  };
  return { node, owner, priv, value };
}

/**
 * Which language model and effort level the project's agents use (planner, refiners, implementation agents).
 * Empty = the default; a card's own choice still wins. The model is free text with the aliases as suggestions,
 * since a full model name works too.
 */
function modelFields({ model = null, effort = null } = {}, { disabled = false } = {}) {
  const modelInput = el('input', { type: 'text', placeholder: 'oletus', maxLength: 110, value: model ?? '', autocomplete: 'off', disabled });
  modelInput.setAttribute('list', 'p-models'); // `list` is read-only as a property
  const effortSelect = el('select', { disabled }, el('option', { value: '', textContent: 'oletus' }), ...meta.efforts.map((x) => el('option', { value: x, textContent: x })));
  effortSelect.value = effort ?? '';
  const node = el('div', {},
    el('datalist', { id: 'p-models' }, ...meta.models.map((m) => el('option', { value: m }))),
    el('div', { className: 'pair' },
      el('div', {}, el('label', { className: 'f', textContent: 'Kielimalli' }), modelInput),
      el('div', {}, el('label', { className: 'f', textContent: 'Effort' }), effortSelect)),
    el('div', { className: 'hint', textContent: 'Tyhjä = Claude Coden oletus. Koskee projektin suunnittelijaa, tarkentajia ja toteutusagentteja. Kortin oma valinta ohittaa tämän; automaattinen katselmointi käyttää omaa asetustaan.' }));
  return { node, value: () => ({ model: modelInput.value.trim(), effort: effortSelect.value }) };
}

/** The project's model and effort, changeable at every step. */
function settingsBox(p) {
  const planning = p.step === 'planning';
  const mf = modelFields(p, { disabled: planning });
  const save = el('button', { type: 'button', textContent: 'Tallenna', disabled: planning, title: planning ? 'Odota, että suunnittelu valmistuu' : '' });
  save.addEventListener('click', async () => {
    if (!(await projectAct('settings', mf.value(), save, 'Tallennetaan…'))) return;
    const note = document.getElementById('p-saved'); // the dialog was redrawn: say it worked on the new one
    if (note) { note.textContent = '✓ Tallennettu'; setTimeout(() => { note.textContent = ''; }, 2500); }
  });
  const hide = el('input', { type: 'checkbox', checked: p.hidden, disabled: planning });
  hide.addEventListener('change', async () => {
    hide.disabled = true;
    setPError('');
    try {
      await api(`/api/projects/${encodeURIComponent(p.name)}/hidden`, { method: 'POST', body: { hidden: hide.checked } });
      projectJson = '';
      loadProject();
      await Promise.all([loadProjects(), refresh(true), loadNext()]);
      paintLog(); // its lines of the project come and go with it
    } catch (e) { setPError(e.message); hide.checked = !hide.checked; hide.disabled = false; }
  });
  return el('div', {}, el('h3', { textContent: 'Malli ja effort' }), mf.node,
    el('div', { className: 'actions' }, el('span', { id: 'p-saved', className: 'muted' }), save),
    el('label', { className: 'inline', style: 'margin-top:10px' }, hide, 'Piilota projekti'),
    el('div', { className: 'hint', textContent: 'Piilotetun projektin kortit eivät näy taululla, agenteissa, muutoksissa, riippuvuuksissa, "Sinun vuorosi" -listassa, tapahtumalokissa eikä Ohjaajalle. Projekti näkyy edelleen projektilistassa. Agentit ja tarkastukset jatkavat kuten ennenkin.' }));
}

const commits = (n) => `${n} commit${n === 1 ? '' : 'tia'}`;

/** One repository's branch in words: the branch, how it relates to the base branch and to its upstream, uncommitted files. */
function branchText(r) {
  const parts = [r.branch ? `haara ${r.branch}` : r.head ? `ei haaraa (irrallinen HEAD ${r.head})` : 'ei committeja'];
  if (r.base && r.ahead != null && !(r.upstream === r.base)) {
    parts.push(r.ahead === 0 && r.behind === 0 ? `sama kuin ${r.base}`
      : r.ahead === 0 ? `kaikki jo ${r.base}:ssa, joka on ${commits(r.behind)} edellä`
      : `${commits(r.ahead)}, joita ${r.base} ei sisällä${r.behind ? `; ${r.base} on ${commits(r.behind)} edellä` : ''}`);
  }
  if (r.branch && !r.upstream) parts.push('ei etähaaraa');
  else if (r.upstream) parts.push(r.toPush || r.toPull ? [r.toPush ? `${commits(r.toPush)} pushaamatta` : '', r.toPull ? `${commits(r.toPull)} hakematta (${r.upstream})` : ''].filter(Boolean).join(', ') : `ajan tasalla: ${r.upstream}`);
  if (r.changed) parts.push(`${r.changed} tiedosto${r.changed === 1 ? '' : 'a'} commitoimatta`);
  return parts.join(' · ');
}

/** Where each repository of the project stands, with a button that fetches the remote and reads it again. */
function branchesBox(p) {
  if (projectBranches?.name !== p.name) { // first drawn: read them once (a new or just-added project gets here too)
    projectBranches = { name: p.name, repos: null };
    loadBranches(p.name);
  }
  const repos = projectBranches.repos;
  const box = el('div', { style: 'margin-top:6px' });
  if (!repos) return box.append(el('div', { className: 'muted', textContent: 'Luetaan haaroja…' })), box;
  for (const r of repos) {
    if (p.workspace) box.append(el('div', { className: 'mono', style: 'margin-top:8px;font-weight:600', textContent: r.repo }));
    box.append(targetPicker(p, r),
      el('div', { className: 'muted', textContent: 'Kansio tällä koneella (ei vaikuta siihen, mihin kortit menevät):' }),
      el('div', {}, branchText(r)), branchSwitch(p, r));
  }
  const again = el('button', { type: 'button', textContent: 'Päivitä', title: 'Hakee etärepon tilan (git fetch) ja lukee haarat uudelleen. Mitään ei muuteta.', style: 'margin-top:6px' });
  again.addEventListener('click', () => loadBranches(p.name, { fetch: true, button: again }));
  box.append(again);
  return box;
}

/** A repository's branch picker: switches its folder to another branch (and pulls it when that is a fast-forward). */
function branchSwitch(p, r) {
  const pick = el('select', { style: 'max-width:280px' }, ...(r.switchable ?? []).map((b) => el('option', { value: b, textContent: b, selected: b === r.branch })));
  if (!r.branch) pick.prepend(el('option', { value: '', textContent: '(ei haaraa)', selected: true }));
  const go = el('button', { type: 'button', textContent: 'Vaihda haara', disabled: true, title: r.changed ? 'Repossa on commitoimattomia muutoksia: commitoi tai stashaa ne ensin' : 'Vaihtaa repon kansion valittuun haaraan ja hakee sen etärepon uudet commitit' });
  pick.addEventListener('change', () => { go.disabled = !pick.value || pick.value === r.branch || r.changed > 0; });
  go.addEventListener('click', async () => {
    go.disabled = pick.disabled = true;
    go.textContent = 'Vaihdetaan…';
    setPError('');
    try {
      const repos = await api(`/api/projects/${encodeURIComponent(p.name)}/branches`, { method: 'POST', body: { repo: r.repo, branch: pick.value } });
      if (openProject !== p.name) return;
      projectBranches = { name: p.name, repos };
      projectJson = '';
      loadProject();
    } catch (e) {
      setPError(e.message);
      go.disabled = pick.disabled = false;
      go.textContent = 'Vaihda haara';
    }
  });
  return el('div', { className: 'row', style: 'gap:6px;margin:2px 0 6px' }, pick, go);
}

/**
 * The branch the repository's new cards fork from and whose pull requests go into (a card's own choice wins).
 * Empty = the repository's default branch. The server checks that the branch exists.
 */
function targetPicker(p, r) {
  const listId = `p-targets-${r.repo}`;
  const input = el('input', { type: 'text', value: r.target ?? '', placeholder: `oletushaara${r.base && !r.target ? ` (${r.base})` : ''}`, autocomplete: 'off', maxLength: 200, style: 'max-width:280px' });
  input.setAttribute('list', listId); // `list` is read-only as a property
  const save = el('button', { type: 'button', textContent: 'Aseta', disabled: true, title: 'Uudet kortit tehdään tästä haarasta ja niiden pull requestit menevät siihen. Jo aloitetut kortit pysyvät haarassaan.' });
  input.addEventListener('input', () => { save.disabled = input.value.trim() === (r.target ?? ''); });
  save.addEventListener('click', async () => {
    save.disabled = input.disabled = true;
    save.textContent = 'Tarkistetaan…';
    setPError('');
    try {
      const repos = await api(`/api/projects/${encodeURIComponent(p.name)}/base`, { method: 'POST', body: { repo: r.repo, branch: input.value.trim() } });
      if (openProject !== p.name) return;
      projectBranches = { name: p.name, repos };
      projectJson = '';
      loadProject();
    } catch (e) {
      setPError(e.message);
      save.disabled = input.disabled = false;
      save.textContent = 'Aseta';
    }
  });
  const options = [...new Set([r.target, r.branch, ...(r.switchable ?? [])].filter(Boolean))];
  const box = el('div', { style: 'margin:2px 0 8px' },
    el('div', { className: 'muted', textContent: 'Korttien kohdehaara: kortit tehdään tästä haarasta ja niiden pull requestit menevät siihen' }),
    el('datalist', { id: listId }, ...options.map((b) => el('option', { value: b }))),
    el('div', { className: 'row', style: 'gap:6px' }, input, save));
  // The folder is on a branch the cards do not go to: easy to mistake the one for the other, so offer it.
  const goesTo = r.target ?? r.base?.replace(/^origin\//, '');
  if (r.branch && goesTo && r.branch !== goesTo) {
    const use = el('button', { type: 'button', textContent: `Käytä haaraa ${r.branch}` });
    use.addEventListener('click', () => { input.value = r.branch; save.disabled = false; save.click(); });
    box.append(el('div', { className: 'hint', style: 'margin-top:4px' },
      `Kansio on haarassa ${r.branch}, mutta kortit menevät haaraan ${goesTo}. `, use));
  }
  return box;
}

async function loadBranches(name, { fetch = false, button = null } = {}) {
  if (button) { button.disabled = true; button.textContent = 'Haetaan…'; }
  try {
    const repos = await api(`/api/projects/${encodeURIComponent(name)}/branches${fetch ? '?fetch=1' : ''}`);
    if (openProject !== name) return;
    projectBranches = { name, repos };
    projectJson = ''; // redraw with them
    loadProject();
  } catch (e) {
    setPError(e.message);
    if (button) { button.disabled = false; button.textContent = 'Päivitä'; }
    else if (projectBranches?.name === name) { projectBranches.repos = []; projectJson = ''; loadProject(); } // leave the button to try again
  }
}

/** The answer to "where is this project's code?", shown at the top of every project step. */
function sourceControlBox(p) {
  const sc = p.sourceControl;
  const box = el('div', { className: 'where' }, p.workspace
    ? el('div', {}, el('b', { textContent: 'Reposet: ' }), ...p.workspaceRepos.map((r) => el('div', { className: 'mono', textContent: `${r.name} — ${r.path}` })))
    : el('div', {}, el('b', { textContent: 'Lähdekoodi: ' }), el('span', { textContent: `git-repo ${p.path}` })));
  if (p.step !== 'remote') box.append(branchesBox(p)); // before the first push a new GitHub project has nothing to compare
  if (p.workspace) return box;
  if (sc.kind === 'local') {
    box.append(el('div', { className: 'muted', textContent: 'Ei etärepoa: koodi on vain tällä koneella.' }));
    if (p.step !== 'planning' && !p.imported) { // an added repository's branch is not necessarily main, which is what gets pushed
      const move = el('button', { type: 'button', textContent: 'Vie GitHubiin…', style: 'margin-top:6px' });
      move.addEventListener('click', () => {
        const gf = githubFields();
        const go = el('button', { type: 'button', className: 'primary', textContent: 'Luo GitHub-repo ja pushaa' });
        go.addEventListener('click', () => projectAct('source-control', { sourceControl: gf.value() }, go, 'Luodaan ja pushataan…'));
        move.replaceWith(el('div', {}, gf.node, el('div', { className: 'actions' }, go)));
      });
      box.append(move);
    }
  } else if (sc.kind === 'remote') {
    box.append(el('div', {}, el('b', { textContent: 'Etärepo: ' }), sc.url));
  } else if (sc.pushed) {
    const link =/^https:\/\//.test(sc.url ?? '') ? el('a', { href: sc.url, target: '_blank', rel: 'noopener', textContent: sc.fullName }) : el('span', { textContent: sc.fullName });
    box.append(el('div', {}, el('b', { textContent: 'Etärepo: ' }), 'GitHub ', link, el('span', { className: 'muted', textContent: sc.private == null ? '' : sc.private ? ' (yksityinen)' : ' (julkinen)' })));
  } else {
    box.append(el('div', {}, el('b', { textContent: 'Etärepo: ' }), `GitHub ${sc.fullName ?? `${sc.owner || 'oma tili'}/${p.name}`}, ei vielä valmis`));
  }
  return box;
}

function openProjectDialog(name = null, { existing = false } = {}) {
  for (const d of [dlg, detail]) if (d.open) d.close(); // a command can open a project from another dialog
  openProject = name;
  openProjectData = null;
  projectJson = '';
  projectBranches = null;
  setPError('');
  if (name) loadProject(); else if (existing) renderAddExisting(); else renderNewProject();
  if (!pdlg.open) pdlg.showModal();
  clearInterval(projectTimer);
  projectTimer = setInterval(loadProject, 2000);
}
pdlg.addEventListener('close', () => { clearInterval(projectTimer); openProject = null; openProjectData = null; loadProjects(); refresh(true); });
document.getElementById('p-close').addEventListener('click', () => pdlg.close());
document.getElementById('new-project').addEventListener('click', () => openProjectDialog(null));
document.getElementById('add-project').addEventListener('click', () => openProjectDialog(null, { existing: true }));

async function loadProject() {
  if (!openProject) return;
  try {
    const name = encodeURIComponent(openProject);
    const p = await api(`/api/projects/${name}`);
    if (p.imported) p.map = await api(`/api/projects/${name}/map`).catch(() => null); // the code map of an existing project
    if (hasCode(p)) p.auditState = await api(`/api/projects/${name}/audit`).catch(() => null);
    showProject(p);
  } catch (e) { setPError(e.message); }
}

/** The code map of an existing project: explored once, remembered, and given to every agent of the project. */
function exploreBox(p) {
  const m = p.map;
  const box = el('div', {}, el('h3', { textContent: 'Koodikartta' }));
  if (!m) return box;
  const start = (full, button, busy) => async () => {
    button.disabled = true;
    button.textContent = busy;
    setPError('');
    try { await api(`/api/projects/${encodeURIComponent(p.name)}/explore`, { method: 'POST', body: { full } }); projectJson = ''; loadProject(); loadProjects(); }
    catch (e) { setPError(e.message); button.disabled = false; }
  };
  const age = (r) => (r.behind == null ? 'ei tutkittu' : r.behind === 0 ? 'ajan tasalla' : `${r.behind} committia uudempi`);
  if (m.state === 'running') {
    box.append(el('div', { textContent: 'Tutkija lukee koodia. Se kestää muutaman minuutin, ja työ jatkuu taustalla, vaikka sulkisit ikkunan.' }));
    if (m.activity) box.append(el('div', { className: 'muted', style: 'font: 12.5px/1.5 var(--mono); margin-top:6px', textContent: m.activity }));
    return box;
  }
  if (m.error) box.append(el('div', { className: 'err pre', textContent: m.error }));
  if (m.state === 'none' || m.state === 'error') {
    const go = el('button', { type: 'button', className: 'primary', textContent: 'Tutki projekti' });
    go.addEventListener('click', start(false, go, 'Käynnistetään…'));
    box.append(el('div', { textContent: 'Projektia ei ole vielä tutkittu. Tutkija lukee koodin (vain luku) ja kirjoittaa kartan: rakenteen, komennot, käytännöt' + (p.workspace ? ' ja sen, miten reposet puhuvat keskenään' : '') + '. Kartta annetaan jokaiselle projektin agentille (tarkentaja, toteutus' + (p.workspace ? ', suunnittelija' : '') + '), joten ne eivät tutki samoja asioita joka kortilla uudelleen.' }),
      el('div', { className: 'actions' }, go));
    return box;
  }
  box.append(el('div', { textContent: `Tutkittu ${stamp(m.exploredAt)}. Kartta annetaan jokaiselle projektin agentille.` }),
    el('div', { className: 'muted', textContent: m.repos.map((r) => `${r.name}: ${age(r)}`).join(' · ') }));
  const row = el('div', { className: 'actions' });
  const all = el('button', { type: 'button', textContent: 'Tutki kaikki uudelleen', title: 'Lukee kaikki repot alusta' });
  all.addEventListener('click', start(true, all, 'Käynnistetään…'));
  const upd = el('button', { type: 'button', className: m.stale ? 'primary' : '', textContent: m.stale ? 'Päivitä kartta' : 'Tarkista muutokset', title: 'Lukee vain ne repot, joihin on tullut uusia committeja, ja vain muuttuneet kohdat' });
  upd.addEventListener('click', start(false, upd, 'Käynnistetään…'));
  row.append(all, upd);
  box.append(row, el('details', { style: 'margin-top:8px' }, el('summary', { textContent: 'Näytä kartta' }), el('div', { className: 'pre', style: 'margin-top:4px;max-height:320px;overflow:auto', textContent: m.text })));
  return box;
}

/** Whether the project has code to audit: an added folder, or a new project whose tasks have been made. */
const hasCode = (p) => p.imported || p.step === 'done';

const SEVERITY_LABEL = { critical: 'kriittinen', high: 'korkea', medium: 'keskitaso', low: 'matala' };
const SEVERITY_COLOR = { critical: 'var(--high)', high: 'var(--high)', medium: 'var(--muted)', low: 'var(--muted)' };

/**
 * The project's vulnerability audit: on/off and the interval in minutes (the project is then audited by itself),
 * a button to audit now, and the latest findings. A read-only agent does the audit; nothing is changed in the code.
 */
function auditBox(p) {
  const a = p.auditState;
  const box = el('div', {}, el('h3', { textContent: 'Haavoittuvuustarkastus' }));
  if (!a) return box;
  const busy = a.state === 'running';
  const on = el('input', { type: 'checkbox', checked: a.enabled });
  const every = el('input', { type: 'number', min: 5, max: 525600, step: 1, value: a.everyMin, style: 'width:110px' });
  const save = el('button', { type: 'button', textContent: 'Tallenna', disabled: p.step === 'planning' });
  save.addEventListener('click', async () => {
    if (!(await projectAct('audit', { enabled: on.checked, everyMin: Number(every.value) }, save, 'Tallennetaan…'))) return;
    const note = document.getElementById('a-saved');
    if (note) { note.textContent = '✓ Tallennettu'; setTimeout(() => { note.textContent = ''; }, 2500); }
  });
  const now = el('button', { type: 'button', textContent: busy ? 'Tarkastetaan…' : 'Tarkasta nyt', disabled: busy, title: 'Käynnistää tarkastuksen heti, vaikka ajastus olisi pois päältä' });
  now.addEventListener('click', () => projectAct('audit/run', {}, now, 'Käynnistetään…'));
  box.append(
    el('label', { className: 'inline' }, on, 'Tarkasta projektin haavoittuvuudet automaattisesti'),
    el('label', { className: 'f', textContent: 'Aikaväli (minuuttia)' }), every,
    el('div', { className: 'hint', textContent: 'Lukuagentti käy läpi koodin ja riippuvuudet (vain luku) ja kirjaa löydökset tähän. Pienin aikaväli on 5 min; 60 = tunti, 1440 = vuorokausi. Jokainen tarkastus kuluttaa tokeneita.' }),
    el('div', { className: 'actions' }, el('span', { id: 'a-saved', className: 'muted' }), now, save));
  if (busy) {
    box.append(el('div', { textContent: 'Tarkastaja lukee koodia. Työ jatkuu taustalla, vaikka sulkisit ikkunan.' }));
    if (a.activity) box.append(el('div', { className: 'muted', style: 'font: 12.5px/1.5 var(--mono); margin-top:6px', textContent: a.activity }));
    return box;
  }
  if (a.error) box.append(el('div', { className: 'err pre', textContent: a.error }));
  if (a.enabled && a.nextAt) box.append(el('div', { className: 'muted', textContent: `Seuraava tarkastus ${stamp(a.nextAt)}` }));
  if (!a.checkedAt) return box;
  const c = a.counts;
  box.append(el('div', { textContent: `Tarkastettu ${stamp(a.checkedAt)}: ${a.findings.length ? ['critical', 'high', 'medium', 'low'].filter((s) => c[s]).map((s) => `${c[s]} ${SEVERITY_LABEL[s]}`).join(', ') : 'ei löydöksiä'}.` }));
  if (a.summary) box.append(el('div', { className: 'muted', textContent: a.summary }));
  for (const f of a.findings) {
    box.append(el('details', { style: 'margin-top:6px' },
      el('summary', {}, el('b', { style: `color:${SEVERITY_COLOR[f.severity]}`, textContent: `[${SEVERITY_LABEL[f.severity]}] ` }), f.title,
        f.file ? el('span', { className: 'muted mono', textContent: ` ${f.repo ? `${f.repo}: ` : ''}${f.file}${f.line ? `:${f.line}` : ''}` }) : '',
        f.card ? el('span', { className: 'muted', textContent: ' · kortti tehty' }) : ''),
      el('div', { className: 'pre', style: 'margin-top:4px', textContent: f.description }),
      f.fix ? el('div', { className: 'pre muted', textContent: `Korjaus: ${f.fix}` }) : '',
      el('div', { className: 'actions' }, findingTicketButton(f))));
  }
  return box;
}

/** A finding's card: a button that makes it (into the inbox, to be refined like any card), or opens it once made. */
function findingTicketButton(f) {
  if (f.card) {
    const open = el('button', { type: 'button', textContent: 'Avaa kortti' });
    open.addEventListener('click', async () => { pdlg.close(); await refresh(true); openDetail(f.card.id); });
    return open;
  }
  const make = el('button', { type: 'button', textContent: 'Tee kortti', title: 'Tekee löydöksestä kortin Inboxiin: kuvaus, sijainti ja korjausehdotus kortin kuvaukseksi, prioriteetti vakavuuden mukaan' });
  make.addEventListener('click', () => projectAct('audit/ticket', { finding: f.id }, make, 'Tehdään…'));
  return make;
}

async function projectAct(path, body, button, busyText) {
  const label = button.textContent;
  let ok = false;
  button.disabled = true;
  button.textContent = busyText;
  setPError('');
  try {
    const p = await api(`/api/projects/${encodeURIComponent(openProject)}/${path}`, { method: 'POST', body });
    projectJson = ''; // redraw even when nothing changed, so the button comes back
    showProject(p);
    ok = true;
  } catch (e) {
    setPError(e.message);
    button.disabled = false;
    button.textContent = label;
  }
  loadProjects();
  if (path === 'tasks' || path === 'audit/ticket') refresh(true);
  return ok;
}

function renderNewProject() {
  document.getElementById('p-title').textContent = 'Uusi projekti';
  const name = el('input', { type: 'text', id: 'p-name', maxLength: 100, placeholder: 'esim. tilausportaali', autocomplete: 'off', autofocus: true }); // showModal focuses it
  const local = el('input', { type: 'radio', name: 'p-sc', value: 'local', checked: true });
  const gh = el('input', { type: 'radio', name: 'p-sc', value: 'github' });
  const gf = githubFields();
  gf.node.style.margin = '0 0 0 28px';
  const mf = modelFields();
  const summary = el('div', { className: 'where' });
  const sep = meta.reposRoot.includes('\\') ? '\\' : '/';
  const paint = () => {
    const n = name.value.trim() || '<nimi>';
    gf.node.style.display = gh.checked ? '' : 'none';
    summary.replaceChildren(
      el('div', {}, el('b', { textContent: 'Lähdekoodi: ' }), `git-repo ${meta.reposRoot.replace(/[\\/]$/, '')}${sep}${n}`),
      gh.checked
        ? el('div', {}, el('b', { textContent: 'Etärepo: ' }), `GitHub ${gf.owner.value.trim() || 'oma tili'}/${n} (${gf.priv.checked ? 'yksityinen' : 'julkinen'}), main-haara pushataan sinne heti`)
        : el('div', { className: 'muted', textContent: 'Ei etärepoa: koodi on vain tällä koneella. Voit viedä sen GitHubiin myöhemmin.' }));
  };
  for (const x of [name, local, gh, gf.owner, gf.priv]) { x.addEventListener('input', paint); x.addEventListener('change', paint); }
  const go = el('button', { type: 'button', className: 'primary', textContent: 'Luo projekti' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = gh.checked ? 'Luodaan ja pushataan GitHubiin…' : 'Luodaan…';
    setPError('');
    try {
      const p = await api('/api/projects', { method: 'POST', body: { name: name.value, sourceControl: gh.checked ? gf.value() : { kind: 'local' }, ...mf.value() } });
      openProject = p.name;
      showProject(p);
      loadProjects();
    } catch (e) {
      setPError(e.message);
      go.disabled = false;
      go.textContent = 'Luo projekti';
    }
  });
  name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
  const cancel = el('button', { type: 'button', textContent: 'Peruuta' });
  cancel.addEventListener('click', () => pdlg.close());
  document.getElementById('p-body').replaceChildren(
    el('label', { className: 'f', htmlFor: 'p-name', textContent: 'Projektin nimi (kansion ja repon nimi)' }), name,
    el('label', { className: 'f', textContent: 'Missä lähdekoodi säilytetään?' }),
    el('label', { className: 'choice' }, local, el('span', {}, 'Paikallinen git-repo', el('small', { textContent: 'Vain tällä koneella. Ei kirjautumista eikä etärepoa.' }))),
    el('label', { className: 'choice' }, gh, el('span', {}, 'GitHub', el('small', { textContent: 'Luo repon GitHubiin ja pushaa sinne. Kirjautuminen: gh auth login tai Git Credential Manager.' }))),
    gf.node, summary, el('h3', { textContent: 'Malli ja effort' }), mf.node, el('div', { className: 'actions' }, cancel, go));
  paint();
}

/** Adds a project from a folder that already holds a git repository; nothing in the folder is changed. */
function renderAddExisting() {
  document.getElementById('p-title').textContent = 'Lisää olemassa oleva projekti';
  const folder = el('textarea', { id: 'p-folder', rows: 3, placeholder: 'esim. C:\\code\\tilausportaali\n(useampi repo: yksi polku per rivi)', autocomplete: 'off', spellcheck: false, autofocus: true });
  folder.style.minHeight = '0';
  const name = el('input', { type: 'text', id: 'p-name', maxLength: 100, placeholder: 'oletuksena kansion nimi', autocomplete: 'off' });
  const mf = modelFields();
  const pickRow = el('div', { style: 'display:flex;gap:8px' }, folder);
  folder.style.flex = '1'; // the desktop app has a native folder picker; in a plain browser the path is typed
  if (window.agentControl?.pickFolder) {
    const browse = el('button', { type: 'button', textContent: 'Selaa…' });
    browse.addEventListener('click', async () => {
      const picked = await window.agentControl.pickFolder().catch(() => null);
      if (picked) { folder.value = folder.value.trim() ? `${folder.value.trim()}\n${picked}` : picked; folder.focus(); }
    });
    pickRow.append(browse);
  }
  const go = el('button', { type: 'button', className: 'primary', textContent: 'Lisää projekti' });
  go.addEventListener('click', async () => {
    if (!folder.value.trim()) return setPError('Kirjoita projektin kansion koko polku.');
    go.disabled = true;
    go.textContent = 'Lisätään…';
    setPError('');
    try {
      const body = { paths: folder.value.split(/\r?\n|;/).map((x) => x.trim()).filter(Boolean), name: name.value, ...mf.value() };
      let p;
      for (let asked = 0; !p; asked++) {
        try { p = await api('/api/projects/existing', { method: 'POST', body }); }
        catch (e) { // the server asks first: create a git repository, or one project over a folder of repositories
          if (asked > 3 || e.status !== 409 || !(e.data?.gitInit || e.data?.workspace)) throw e;
          const git = e.data.gitInit;
          if (!(await confirmBox({ title: git ? 'Luodaanko git-repo?' : 'Yksi projekti useasta repostasta?', text: e.message, ok: git ? 'Luo git-repo ja lisää' : 'Lisää yhtenä projektina' }))) throw new Error('Peruttu.');
          body[git ? 'initGit' : 'workspace'] = true;
        }
      }
      openProject = p.name;
      showProject(p);
      loadProjects();
    } catch (e) {
      setPError(e.message);
      go.disabled = false;
      go.textContent = 'Lisää projekti';
    }
  });
  name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
  const cancel = el('button', { type: 'button', textContent: 'Peruuta' });
  cancel.addEventListener('click', () => pdlg.close());
  document.getElementById('p-body').replaceChildren(
    el('label', { className: 'f', htmlFor: 'p-folder', textContent: 'Projektin kansio' }), pickRow,
    el('div', { className: 'hint', textContent: 'Git-repon juurikansio (kansio jossa .git on). Jos kansiossa ei vielä ole git-repoa tai committeja, ohjelma kysyy luodaanko ne. Jos annat useita polkuja (tai kansion, jossa on useita reposia), syntyy yksi projekti, jonka suunnittelija lukee kaikki repot; silloin nimi on pakollinen, ellei repot ole samassa kansiossa. Muuten mitään ei muuteta: agentit työskentelevät omissa worktreeissään ja kansio pysyy omanasi.' }),
    el('label', { className: 'f', htmlFor: 'p-name', textContent: 'Projektin nimi (valinnainen)' }), name,
    el('h3', { textContent: 'Malli ja effort' }), mf.node, el('div', { className: 'actions' }, cancel, go));
}

/** The description and the "make a plan" button: the step of a new project, optional for one over several added repositories. */
function describeParts(p, error) {
  const desc = el('textarea', { id: 'p-desc', value: p.description, style: 'min-height:160px',
    placeholder: p.workspace ? 'Mikä muutos tehdään? Mitä se koskee, ja mitä ei tehdä.' : 'Mitä rakennetaan ja kenelle? Tärkeimmät toiminnot, tekniikat jos tiedät, ja mitä ei tehdä.' });
  const go = el('button', { type: 'button', className: 'primary', textContent: 'Luo suunnitelma' });
  go.addEventListener('click', () => (desc.value.trim() ? projectAct('plan', { description: desc.value }, go, 'Käynnistetään…') : setPError('Kirjoita kuvaus ensin.')));
  return [
    el('label', { className: 'f', htmlFor: 'p-desc', textContent: p.workspace ? 'Kuvaile muutos' : 'Kuvaile projekti' }), desc,
    el('div', { className: 'muted', style: 'margin-top:6px', textContent: p.workspace
      ? 'Suunnittelija lukee kaikkien reposien koodin, valitsee nopeimman toimivan ratkaisun ja pilkkoo työn tehtäviksi, joista jokainen nimeää repot joita se muuttaa. Tarkistat suunnitelman ja tehtävät ennen kuin kortteja luodaan.'
      : 'AgentControl kirjoittaa tästä suunnitelman (PLAN.md) ja pilkkoo sen tehtäviksi. Tarkistat molemmat ennen kuin kortteja luodaan.' }),
    ...(p.planning.error ? [error(p.planning.error)] : []),
    el('div', { className: 'actions' }, micButton(desc), go),
  ];
}

function showProject(p) {
  const json = JSON.stringify(p);
  if (p.name !== openProject) return; // an answer for a project that is no longer on screen
  openProjectData = p;
  if (json === projectJson) return; // keep what the person is typing while nothing changed
  projectJson = json;
  document.getElementById('p-title').textContent = p.name;
  const sc = p.sourceControl;
  const s = p.planning;
  const parts = [sourceControlBox(p), settingsBox(p)];
  if (p.imported) parts.push(exploreBox(p));
  if (hasCode(p)) parts.push(auditBox(p));
  const error = (msg) => el('div', { className: 'err pre', textContent: msg });

  if (p.step === 'remote') {
    parts.push(el('h3', { textContent: 'GitHub' }));
    if (sc.error) parts.push(error(sc.error));
    parts.push(el('div', { className: 'muted', textContent: sc.fullName ? `Repo ${sc.fullName} on luotu, mutta main-haaraa ei ole vielä pushattu.` : 'GitHub-repoa ei ole vielä luotu.' }));
    const row = el('div', { className: 'actions' });
    if (!sc.fullName) {
      const keep = el('button', { type: 'button', textContent: 'Jatka paikallisena' });
      keep.addEventListener('click', () => projectAct('source-control', { sourceControl: { kind: 'local' } }, keep, 'Tallennetaan…'));
      row.append(keep);
    }
    const retry = el('button', { type: 'button', className: 'primary', textContent: 'Yritä uudelleen' });
    retry.addEventListener('click', () => projectAct('source-control', {}, retry, 'Yritetään…'));
    row.append(retry);
    parts.push(row);
  } else if (p.step === 'existing' && p.workspace) {
    parts.push(el('div', { textContent: `Projekti on lisätty repoista ${p.workspaceRepos.map((r) => r.name).join(', ')}. Kansioita ei ole muutettu.` }),
      el('div', { className: 'muted', textContent: `Luo projektille kortteja "+ Uusi kortti" -painikkeella ja valitse repoiksi ne, joita kortti muuttaa (${p.workspaceRepos.map((r) => r.name).join(', ')}). Agentit työskentelevät omissa worktreeissään ja työ yhdistetään kuhunkin repoon tavalliseen tapaan.` }),
      el('details', { style: 'margin-top:10px', open: !!s.error }, el('summary', { textContent: 'Suunnittele isompi muutos kuvauksesta (valinnainen)' }), ...describeParts(p, error)));
  } else if (p.step === 'existing') {
    parts.push(el('div', { textContent: `Projekti on lisätty kansiosta ${p.path}. Kansiota ei ole muutettu.` }),
      el('div', { className: 'muted', textContent: `Luo projektille kortteja "+ Uusi kortti" -painikkeella ja valitse repoksi ${p.name}. Agentit työskentelevät omissa worktreeissään ja työ yhdistetään tähän repoon tavalliseen tapaan.` }));
  } else if (p.step === 'describe') {
    parts.push(...describeParts(p, error));
  } else if (p.step === 'planning') {
    parts.push(el('h3', { textContent: 'Suunnitelma' }),
      el('div', { textContent: 'Claude suunnittelee projektia. Tämä kestää yleensä muutaman minuutin. Voit sulkea ikkunan, työ jatkuu taustalla.' }));
    if (p.activity) parts.push(el('div', { className: 'muted', style: 'font: 12.5px/1.5 var(--mono); margin-top:6px', textContent: p.activity }));
  } else if (p.step === 'review') {
    if (s.error) parts.push(error(`Viimeisin päivitys epäonnistui: ${s.error}`));
    if (s.summary) parts.push(el('div', { style: 'font-weight:600', textContent: s.summary }));
    parts.push(el('h3', { textContent: 'Suunnitelma (PLAN.md)' }), el('div', { className: 'pre', style: 'max-height:280px;overflow:auto', textContent: s.plan }));
    parts.push(el('h3', { textContent: `Tehtävät (${s.tasks.length})` }));
    const create = el('button', { type: 'button', className: 'primary' });
    const checks = s.tasks.map((t, i) => {
      const cb = el('input', { type: 'checkbox', checked: true, value: String(i), title: 'Luo tästä kortti' });
      const info = [PRIO[t.priority], p.workspace && t.repos?.length ? t.repos.join(', ') : '', t.after != null ? `odottaa tehtävää ${t.after + 1} (${AFTER_LABEL[t.afterKind ?? 'done']})` : ''].filter(Boolean).join(' · ');
      parts.push(el('div', { className: 'task' }, cb, el('div', { style: 'flex:1;min-width:0' },
        el('details', {}, el('summary', { textContent: `${i + 1}. ${t.title}` }), el('div', { className: 'pre', style: 'margin-top:4px', textContent: t.brief })),
        el('div', { className: 'muted', style: 'font-size:12.5px', textContent: info }))));
      return cb;
    });
    const count = () => { const n = checks.filter((c) => c.checked).length; create.textContent = `Luo kortit (${n})`; create.disabled = !n; };
    for (const c of checks) c.addEventListener('change', count);
    count();
    create.addEventListener('click', () => projectAct('tasks', { tasks: checks.filter((c) => c.checked).map((c) => Number(c.value)) }, create, 'Luodaan…'));
    const fb = el('textarea', { style: 'min-height:70px', placeholder: 'Muutoksia suunnitelmaan? Esim. "käytä PostgreSQL:ää" tai "jätä mobiilisovellus pois".' });
    const update = el('button', { type: 'button', textContent: 'Päivitä suunnitelma' });
    update.addEventListener('click', () => (fb.value.trim() ? projectAct('plan', { feedback: fb.value }, update, 'Käynnistetään…') : setPError('Kirjoita muutospyyntö ensin.')));
    const where = sc.kind === 'github' ? ` ja pushataan GitHubiin (${sc.fullName})` : ', vain paikallisesti';
    parts.push(el('h3', { textContent: 'Muutospyyntö' }), fb, el('div', { className: 'actions' }, micButton(fb), update),
      el('div', { className: 'muted', style: 'margin-top:12px', textContent: p.workspace
        ? 'Luo kortit: valitut tehtävät tulevat Inboxiin kortteina, joista kukin työskentelee tehtävän nimeämissä repoissa. Reposeihin ei kosketa ennen kuin aloitat kortin.'
        : `Luo kortit: suunnitelma tallennetaan tiedostoon PLAN.md ja commitoidaan main-haaraan${where}. Valitut tehtävät tulevat Inboxiin kortteina repolle ${p.name}.` }),
      el('div', { className: 'actions' }, create));
  } else {
    parts.push(el('div', { textContent: `Suunnitelma on tallennettu${p.workspace ? '' : ' tiedostoon PLAN.md'}, ja Inboxiin luotiin ${p.cards.length} korttia.` }),
      el('div', { className: 'muted', textContent: 'Avaa kortti ja paina "Aloita tarkennus", niin se etenee tavalliseen tapaan.' }),
      el('details', { style: 'margin-top:10px' }, el('summary', { textContent: 'Näytä suunnitelma' }), el('div', { className: 'pre', style: 'margin-top:4px', textContent: s.plan })));
  }
  const remove = el('button', { type: 'button', className: 'danger', textContent: 'Poista projekti…', disabled: p.step === 'planning', title: p.step === 'planning' ? 'Odota, että suunnittelu valmistuu' : '' });
  remove.addEventListener('click', () => deleteProject(p));
  parts.push(el('div', { className: 'actions', style: 'margin-top:20px;border-top:1px solid var(--border);padding-top:12px' }, remove));
  document.getElementById('p-body').replaceChildren(...parts);
}

async function deleteProject(p) {
  const github = p.sourceControl.kind === 'github' && p.sourceControl.fullName;
  const answer = await confirmBox({
    title: `Poista projekti ${p.name}`,
    text: `Projekti poistuu AgentControlista ja sivupalkista.`
      + (p.cards.length || p.planCard ? ` Sen kortit (${p.cards.length + (p.planCard ? 1 : 0)}) siirtyvät arkistoon.` : '')
      + (github ? `\n\nGitHub-repo ${p.sourceControl.fullName} jää GitHubiin; poista se tarvittaessa siellä.` : ''),
    ok: 'Poista projekti',
    danger: true,
    checkbox: p.imported ? null : `Poista myös kansio ${p.path} ja sen kaikki tiedostot. Tätä ei voi perua.`, // an added folder is the person's own: never offered
  });
  if (!answer) { reply(`Projektia ${p.name} ei poistettu.`); return false; }
  let ok = false;
  try {
    const out = await api(`/api/projects/${encodeURIComponent(p.name)}/delete`, { method: 'POST', body: { deleteFolder: answer.checked === true } });
    if (pdlg.open) pdlg.close();
    reply(`Projekti ${out.removed} poistettu.${out.archived ? ` ${out.archived} korttia siirtyi arkistoon.` : ''}${out.folderDeleted ? ` Kansio ${p.path} poistettu.` : ` Kansio ${p.path} jäi paikalleen.`}`);
    ok = true;
  } catch (e) {
    if (pdlg.open) setPError(e.message);
    reply(`Poisto ei onnistunut: ${e.message}`, { error: true });
  }
  loadProjects();
  loadNext();
  refresh(true);
  return ok;
}

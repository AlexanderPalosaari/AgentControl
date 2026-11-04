'use strict';
// card detail: dispatcher, agent run, diff and refinement.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- dispatcher ----
let dispatcher = null;
async function loadDispatcher() {
  try {
    dispatcher = await api('/api/dispatcher');
    document.getElementById('disp').textContent = `${dispatcher.night ? 'Yöraja' : 'Päiväraja'} ${dispatcher.limit}. Ajossa ${dispatcher.running}.`;
    document.getElementById('disp-count').innerHTML = `<b>${dispatcher.running}</b> / ${dispatcher.limit}`;
    document.getElementById('disp-bars').replaceChildren(...Array.from({ length: dispatcher.limit }, (_, i) => el('span', { className: i < dispatcher.running ? 'on' : '' })));
    document.getElementById('disp-toggle').textContent = dispatcher.enabled ? 'Tauota' : 'Jatka ajoa';
  } catch (e) { toast(e.message); }
}
document.getElementById('disp-toggle').addEventListener('click', async () => {
  const next = !dispatcher.enabled;
  dispatcher.enabled = next; // optimistic, so a second voice command right after sees the new state
  await api('/api/dispatcher', { method: 'POST', body: { enabled: next } });
  loadDispatcher();
});

// ---- card detail: agent run ----
let runJson = '';
const RUN_LABEL = { starting: 'käynnistyy', running: 'työskentelee', reviewing: 'katselmoidaan', needs_input: 'odottaa sinua', finished: 'valmis', failed: 'epäonnistui', stopped: 'pysäytetty' };

async function loadRun() {
  if (!openId) return;
  try {
    const d = await api(`/api/cards/${openId}/run`);
    const json = JSON.stringify(d);
    if (json === runJson) return;
    runJson = json;
    renderRun(d);
  } catch (e) { toast(e.message); }
}

async function runAct(path, body) {
  let ok = false;
  try { await api(`/api/cards/${openId}/run/${path}`, { method: 'POST', body: body ?? {} }); ok = true; }
  catch (e) { toast(e.message); }
  // Answering and retrying move the card on; stopping keeps the dialog open so the stopped state can be read.
  if (ok && path !== 'stop') return advanced(path === 'answer' ? 'Vastaus lähetetty agentille' : 'Agentti jatkaa');
  await refresh(true);
  runJson = '';
  await loadRun();
}

const targetOf = (w) => w.base.replace(/^origin\//, ''); // the branch a worktree's work goes into
const targetsOf = (run) => [...new Set(run.worktrees.map(targetOf))].join(', ');
const commitCount = (n) => `${n} commit${n === 1 ? '' : 'tia'}`;

/**
 * POSTs `path`. When the server asks to confirm first (409: the branch may carry other work than the card's),
 * shows why and sends it again confirmed. Resolves to the answer, or null when the person cancelled.
 */
async function postConfirmed(path, title) {
  try {
    return await api(path, { method: 'POST', body: {} });
  } catch (e) {
    if (e.status !== 409 || !e.data?.confirm) throw e;
    const text = `${(e.data.problems ?? [e.message]).join('\n')}\n\nHaarassa voi olla muutakin kuin tämän kortin työtä. Tarkista muutokset ennen kuin jatkat.`;
    if (!(await confirmBox({ title, text, ok: 'Jatka silti', danger: true }))) return null;
    return api(path, { method: 'POST', body: { confirmed: true } });
  }
}

/** Asks the agent to merge the target branch into its work and resolve the conflicts. */
async function resolveConflicts(c, files, target) {
  const go = await confirmBox({
    title: `Työ on ristiriidassa haaran ${target} kanssa`,
    text: `Haaraan ${target} on jo yhdistetty muuta työtä, joka muuttaa samoja kohtia${files?.length ? ` tiedostoissa:\n${files.join('\n')}` : '.'}\n\nAgentti voi ratkaista konfliktit itse: se yhdistää haaran ${target} työhönsä, korjaa ristiriidat ja ajaa testit. Sen jälkeen työ katselmoidaan uudelleen ja voit hyväksyä sen (tai päivittää pull requestin) tavalliseen tapaan.`,
    ok: 'Anna agentin ratkaista',
  });
  if (!go) return false;
  try {
    await api(`/api/cards/${c.id}/resolve-conflicts`, { method: 'POST', body: {} });
    reply(`Agentti ratkaisee konfliktit: ${c.title}. Työ palaa katselmointiin, kun se on valmis.`);
  } catch (err) {
    await confirmBox({ title: 'Konfliktien ratkaisu ei onnistunut', text: err.message, ok: 'Selvä' });
  }
  return false; // not merged: the card goes back to the agent, the view just refreshes
}

/** Squash-merges a reviewed card into its target branch. true = merged, false = failed (told to the person), null = cancelled. */
async function mergeLocal(c, run, commitMessage, button) {
  const first = String(commitMessage ?? c.title).split('\n')[0];
  const repos = run.worktrees.map((w) => w.repo).join(', ');
  const targets = targetsOf(run);
  if (!(await confirmBox({
    title: 'Hyväksy työ projektiin',
    text: `Agentin työ yhdistetään projektin (${repos}) haaraan ${targets} yhdeksi commitiksi:\n"${first}"\n\nKortti siirtyy Doneen ja agentin työkansio poistetaan. Mitään ei työnnetä minnekään.\n\nProjektin kansion pitää olla haarassa ${targets} ja ilman tallentamattomia muutoksia.`,
    ok: 'Hyväksy ja yhdistä',
  }))) return null;
  button.disabled = true;
  try {
    if (await postConfirmed(`/api/cards/${c.id}/merge`, 'Hyväksytäänkö työ silti?') === null) { button.disabled = false; return null; }
    return true;
  } catch (e) {
    button.disabled = false;
    if (e.data?.conflict) return resolveConflicts(c, e.data.files, targets); // other cards went in first and touched the same lines
    await confirmBox({ title: 'Yhdistäminen ei onnistunut', text: e.message, ok: 'Selvä' });
    return false;
  }
}

/** Pushes the card's branches to Azure DevOps and opens the pull requests. Same return values as mergeLocal. */
async function openPullRequest(c, run, button, preview) {
  const lines = (preview ?? []).filter((p) => !p.gone).map((p) => `${p.repo}: ${p.branch} → ${p.target}${p.commits != null ? ` (${commitCount(p.commits)})` : ''}`);
  const text = `Tämä lähettää haaran Azure DevOpsiin ja luo pull requestin:\n${lines.length ? lines.join('\n') : run.worktrees.map((w) => `${w.branch} → ${targetOf(w)}`).join('\n')}`;
  if (!(await confirmBox({ title: 'Luo pull request', text, ok: 'Lähetä ja luo PR' }))) return null;
  button.disabled = true;
  try {
    if (await postConfirmed(`/api/cards/${c.id}/pr`, 'Luodaanko pull request silti?') === null) { button.disabled = false; return null; }
    return true;
  } catch (e) { button.disabled = false; toast(e.message); return false; }
}

/** Pushes the commits the card's branches gained after their pull requests were opened. Same return values as mergeLocal. */
async function updatePullRequest(c, waiting, button) {
  const text = `Tämä lähettää uudet commitit Azure DevOpsiin, jolloin avoin pull request päivittyy:\n${waiting.map((p) => `${p.repo}: ${p.branch} (${commitCount(p.toPush)})`).join('\n')}`;
  if (!(await confirmBox({ title: 'Päivitä pull request', text, ok: 'Lähetä' }))) return null;
  button.disabled = true;
  try {
    if (await postConfirmed(`/api/cards/${c.id}/pr/update`, 'Päivitetäänkö pull request silti?') === null) { button.disabled = false; return null; }
    return true;
  } catch (e) { button.disabled = false; toast(e.message); return false; }
}

function renderRun(d) {
  const box = document.getElementById('d-run');
  const run = d.run;
  paintDiffButton(run);
  if (!run) return box.replaceChildren();
  const parts = [el('h3', { textContent: 'Toteutus' })];
  parts.push(el('div', {}, el('strong', { textContent: RUN_LABEL[run.state] ?? run.state }),
    el('span', { className: 'muted', textContent: run.model ? ` · ${run.model}${run.effort ? ' / ' + run.effort : ''}` : '' })));
  for (const w of run.worktrees) parts.push(el('div', { className: 'muted', textContent: `${w.repo}: ${w.branch}, kohde ${targetOf(w)} (${w.path})` }));
  if (run.agentId) parts.push(el('div', { className: 'muted', textContent: `agentti ${run.agentId} · avaa terminaalissa: claude attach ${run.agentId}` }));
  if (run.review) {
    const rv = run.review;
    const head = rv.state === 'failed'
      ? `Automaattinen katselmointi epäonnistui: ${rv.error}`
      : `Automaattinen katselmointi: ${rv.findings.length} löydöstä${rv.round ? ', agentti sai yhden korjauskierroksen' : ''}`;
    parts.push(el('div', { className: rv.state === 'failed' ? 'err' : 'muted', textContent: head }));
    if (rv.error && rv.state !== 'failed') parts.push(el('div', { className: 'err', textContent: rv.error }));
    for (const f of rv.findings ?? []) {
      parts.push(el('div', { className: 'pre', style: 'margin-top:4px', textContent: `[${f.severity ?? '–'}] ${f.file}${f.line ? ':' + f.line : ''}: ${f.summary}\n${f.failure_scenario}` }));
    }
  }
  if (run.error) parts.push(el('div', { className: 'err pre', textContent: run.error }));
  if (run.waitingFor) {
    const open = el('button', { type: 'button', className: 'primary', textContent: 'Avaa lupakysely', style: 'margin-top:6px' });
    open.addEventListener('click', () => openPermissionPrompt(openId));
    parts.push(el('div', { className: 'pre' },
      el('div', { textContent: `Agentti odottaa lupaa (${run.waitingFor}). Paina "Avaa lupakysely": kysely aukeaa terminaali-ikkunaan, jossa näet komennon ja vastaat numerolla (1 = kyllä, 3 = kyllä ja auto-tila, jolloin agentti ei kysy tavallisista komennoista enää).` }),
      open));
  }

  if (d.question) {
    const reply = el('textarea', { placeholder: 'Vastauksesi agentille', style: 'min-height:70px;width:100%' });
    const send = el('button', { className: 'primary', textContent: 'Lähetä vastaus' });
    send.addEventListener('click', () => runAct('answer', { message: reply.value }));
    parts.push(el('h3', { textContent: 'Agentin kysymys', style: 'margin-top:10px' }), el('div', { className: 'pre', textContent: d.question }), reply, el('div', { className: 'actions' }, micButton(reply), send));
  }
  const buttons = el('div', { className: 'row', style: 'margin-top:8px' });
  if (run.state === 'running' || run.state === 'needs_input') {
    const b = el('button', { textContent: 'Pysäytä' });
    b.addEventListener('click', async () => (await confirmBox({ title: 'Pysäytä agentti', text: 'Pysäytetäänkö agentti? Sen kesken oleva työ jää työkansioon.', ok: 'Pysäytä', danger: true })) && runAct('stop'));
    buttons.append(b);
  }
  if (run.state === 'failed' || run.state === 'stopped') {
    const b = el('button', { className: 'primary', textContent: 'Yritä uudelleen / jatka' });
    b.addEventListener('click', () => runAct('retry'));
    buttons.append(b);
  }
  if (buttons.children.length) parts.push(buttons);
  const card = allCards.find((x) => x.id === openId);
  const prs = d.prs ?? [];
  const preview = d.publish ?? [];
  // After a review or a refresh: what the server would refuse until confirmed, shown before anyone presses a button.
  const problems = preview.flatMap((p) => (p.problems ?? []).map((x) => `${p.repo}: ${x}`));
  if (card?.status === 'review' && problems.length) {
    parts.push(el('div', { className: 'err pre', style: 'margin-top:8px', textContent: `Haarassa voi olla muutakin kuin tämän kortin työtä:\n${problems.join('\n')}` }));
  }
  const conflicted = prs.filter((p) => p.state === 'active' && p.mergeStatus === 'conflicts');
  if (prs.length) {
    parts.push(el('h3', { textContent: 'Pull requestit', style: 'margin-top:10px' }));
    const PR_LABEL = { active: 'avoin', completed: 'yhdistetty', abandoned: 'hylätty' };
    for (const p of prs) {
      const row = el('div', { className: 'row' });
      row.append(/^https?:\/\//.test(p.url) ? el('a', { href: p.url, target: '_blank', rel: 'noopener', textContent: `${p.repo} #${p.id}` }) : el('span', { textContent: `${p.repo} #${p.id}` }),
        el('span', { className: conflicted.includes(p) ? 'err' : 'muted', textContent: `${PR_LABEL[p.state] ?? p.state} · ${p.branch} → ${p.target}${conflicted.includes(p) ? ' · ristiriidassa kohdehaaran kanssa' : ''}` }));
      parts.push(row);
    }
    const waiting = preview.filter((x) => x.toPush > 0 && prs.some((p) => p.repo === x.repo && p.state === 'active'));
    if (card?.status === 'review' && waiting.length) {
      const n = waiting.reduce((sum, x) => sum + x.toPush, 0);
      const b = el('button', { className: 'primary', textContent: `Päivitä pull request (${n === 1 ? '1 uusi commit' : `${n} uutta committia`})`, style: 'margin-top:8px' });
      b.addEventListener('click', async () => {
        const done = await updatePullRequest(card, waiting, b);
        if (done === null) return;
        if (done) toast('Pull request päivitetty');
        runJson = '';
        await loadRun();
      });
      parts.push(b);
    }
    if (card?.status === 'review' && conflicted.length && run.state === 'finished' && run.agentId) {
      const b = el('button', { textContent: 'Anna agentin ratkaista konfliktit', style: 'margin-top:8px' });
      b.addEventListener('click', async () => {
        await resolveConflicts(card, null, [...new Set(conflicted.map((p) => p.target))].join(', '));
        await refresh(true);
        runJson = '';
        await loadRun();
      });
      parts.push(b);
    }
  }
  if (card?.status === 'review' && d.localMerge) {
    const b = el('button', { className: 'primary', textContent: `Hyväksy työ haaraan ${targetsOf(run)}`, style: 'margin-top:8px' });
    b.addEventListener('click', async () => {
      const done = await mergeLocal(card, run, d.commitMessage, b);
      if (done === null) return;
      if (done) return advanced('Työ yhdistetty projektiin, kortti on Done');
      await refresh(true);
      loadNext();
      runJson = '';
      await loadRun();
    });
    parts.push(el('div', { className: 'muted', style: 'margin-top:8px', textContent: 'Tämä projekti ei ole Azure DevOpsissa, joten pull requestia ei voi luoda. Kun olet lukenut raportin ja muutokset, hyväksy työ tästä.' }), b);
  } else if (card?.status === 'review' && run.worktrees.length && prs.length < run.worktrees.length) {
    const open = run.worktrees.filter((w) => !prs.some((p) => p.repo === w.repo));
    const b = el('button', { className: 'primary', textContent: `Luo pull request → ${[...new Set(open.map(targetOf))].join(', ')}`, style: 'margin-top:8px' });
    b.addEventListener('click', async () => {
      const done = await openPullRequest(card, run, b, preview.filter((p) => open.some((w) => w.repo === p.repo)));
      if (done === null) return;
      if (done) return advanced('Pull request luotu');
      await refresh(true);
      runJson = '';
      await loadRun();
    });
    parts.push(b);
  }
  if (d.report) parts.push(el('h3', { textContent: 'Raportti', style: 'margin-top:10px' }), el('div', { className: 'pre', textContent: d.report }));
  if (d.commitMessage) parts.push(el('h3', { textContent: 'Ehdotettu commit-viesti', style: 'margin-top:10px' }), el('div', { className: 'pre', textContent: d.commitMessage }));
  if (Array.isArray(d.followups) && d.followups.length) {
    parts.push(el('h3', { textContent: 'Jatkotoimenpide-ehdotukset', style: 'margin-top:10px' }),
      ...d.followups.map((f) => el('div', { className: 'pre', textContent: `${f.title ?? ''}${f.brief ? '\n' + f.brief : ''}`, style: 'margin-bottom:6px' })));
  }
  box.replaceChildren(...parts);
}

// ---- card detail: what the agent changed ----
function diffLineClass(line) {
  if (line.startsWith('diff --git')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  return '';
}

function paintDiffButton(run) {
  const box = document.getElementById('d-diff');
  if (!run?.worktrees?.length) return box.replaceChildren();
  if (box.dataset.shown) return; // keep an opened diff while the run data keeps polling
  const b = el('button', { type: 'button', textContent: 'Näytä muutokset' });
  b.addEventListener('click', () => loadDiff());
  box.replaceChildren(el('h3', { textContent: 'Muutokset' }), b);
}

async function loadDiff() {
  const box = document.getElementById('d-diff');
  const id = openId;
  box.dataset.shown = '1';
  box.replaceChildren(el('h3', { textContent: 'Muutokset' }), el('div', { className: 'muted', textContent: 'Haetaan…' }));
  let d;
  try { d = await api(`/api/cards/${id}/diff`); }
  catch (e) { delete box.dataset.shown; toast(e.message); return paintDiffButton({ worktrees: [1] }); }
  if (id !== openId) return;
  const parts = [el('h3', { textContent: 'Muutokset' })];
  const refresh_ = el('button', { type: 'button', textContent: 'Päivitä', style: 'margin-bottom:6px' });
  refresh_.addEventListener('click', () => loadDiff());
  parts.push(refresh_);
  for (const r of d.repos) {
    parts.push(el('div', { className: 'muted', textContent: `${r.repo}: ${r.branch}${r.base ? ` (vs. ${r.base})` : ''}` }));
    if (r.gone) { parts.push(el('div', { className: 'muted', textContent: 'Työkansio on siivottu pois (kortti on valmis).' })); continue; }
    if (r.error) { parts.push(el('div', { className: 'err pre', textContent: r.error })); continue; }
    if (!r.patch) { parts.push(el('div', { className: 'muted', textContent: 'Ei muutoksia.' })); continue; }
    parts.push(el('div', { className: 'pre', textContent: r.stat, style: 'margin-top:4px' }));
    parts.push(el('div', { className: 'diff' }, ...r.patch.split('\n').map((line) => el('div', { className: diffLineClass(line), textContent: line || ' ' }))));
    if (r.truncated) parts.push(el('div', { className: 'muted', textContent: 'Diff on lyhennetty. Katso loput terminaalista.' }));
  }
  box.replaceChildren(...parts);
}

// ---- card detail: refinement ----
const detail = document.getElementById('detail');
let openId = null, refineJson = '', es = null, pollTimer = null;

function setDetailMeta(c) {
  document.getElementById('d-meta').textContent = `${LABELS[c.status]}${phaseInfo.cards[c.id] ? ` (${phaseInfo.cards[c.id].label})` : ''} · ${PRIO[c.priority]}${c.repos.length ? ' · ' + c.repos.join(', ') : ''}${c.baseBranch ? ` → ${c.baseBranch}` : ''}${cardTokens(c.id)}`;
  paintBase(c);
}

// Where a card's base branch can still change: the work forks from it when it starts (the server says the same).
const BASE_EDITABLE = ['inbox', 'refining', 'ready', 'needs_input'];

/** The card's base branch, editable until its work starts; redrawn only when that changes, so typing is kept. */
function paintBase(c) {
  const box = document.getElementById('d-base');
  const key = `${c.id}|${c.status}|${c.baseBranch ?? ''}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (!c.repos.length || !BASE_EDITABLE.includes(c.status)) return box.replaceChildren(); // then the run shows where the work goes
  const input = el('input', { value: c.baseBranch ?? '', placeholder: 'projektin kohdehaara tai repon oletushaara', autocomplete: 'off', style: 'max-width:320px' });
  const save = el('button', { type: 'button', textContent: 'Tallenna', disabled: true });
  input.addEventListener('input', () => { save.disabled = input.value.trim() === (c.baseBranch ?? ''); });
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Tarkistetaan…';
    try {
      const updated = await api(`/api/cards/${c.id}`, { method: 'PATCH', body: { baseBranch: input.value.trim() || null } });
      Object.assign(c, updated);
      setDetailMeta(c);
      toast(updated.baseBranch ? `Kohdehaara: ${updated.baseBranch}` : 'Kohdehaara: projektin tai repon oletus');
    } catch (e) {
      toast(e.message);
      save.disabled = false;
      save.textContent = 'Tallenna';
    }
  });
  box.replaceChildren(el('h3', { textContent: 'Kohdehaara' }), el('div', { className: 'row', style: 'gap:6px' }, input, save),
    el('div', { className: 'hint', textContent: 'Haara, josta agentin työhaara tehdään ja johon pull request tai hyväksytty työ menee. Tyhjä = projektin kohdehaara, muuten repon oletushaara. Voi vaihtaa, kunnes toteutus alkaa.' }));
}

function openDetail(id) {
  const project = allCards.find((x) => x.id === id)?.project;
  if (project) return openProjectDialog(project); // a planning card: its plan and tasks live in the project dialog
  openId = id;
  refineJson = '';
  runJson = '';
  document.getElementById('d-run').replaceChildren();
  delete document.getElementById('d-base').dataset.key; // drawn again for this card by setDetailMeta
  const diffBox = document.getElementById('d-diff');
  diffBox.replaceChildren();
  delete diffBox.dataset.shown;
  const c = allCards.find((x) => x.id === id);
  document.getElementById('d-title').textContent = c.title;
  setDetailMeta(c);
  document.getElementById('d-brief-sec').style.display = c.brief ? '' : 'none';
  document.getElementById('d-brief').textContent = c.brief;
  document.getElementById('live').replaceChildren();
  document.getElementById('d-refine').replaceChildren();
  document.getElementById('d-images').replaceChildren();
  detail.showModal();
  loadImages();
  es = new EventSource(`/api/cards/${id}/live`);
  es.onmessage = (ev) => { addLive(JSON.parse(ev.data)); };
  loadRefine();
  loadRun();
  pollTimer = setInterval(() => { loadRefine(); loadRun(); }, 2000);
}

detail.addEventListener('close', () => {
  es?.close(); es = null;
  clearInterval(pollTimer);
  openId = null;
  refresh(true);
});
document.getElementById('d-close').addEventListener('click', () => detail.close());

async function loadImages() {
  const id = openId;
  if (!id) return;
  try {
    const list = await api(`/api/cards/${id}/attachments`);
    if (id !== openId) return;
    document.getElementById('d-images').replaceChildren(...list.map((a) =>
      el('a', { href: a.url, target: '_blank', rel: 'noopener', title: a.name }, el('img', { src: a.url, alt: a.name }))));
  } catch (e) { toast(e.message); }
}
detail.addEventListener('paste', async (ev) => {
  const images = takeImages(ev);
  if (!images.length || !openId) return;
  const id = openId;
  for (const blob of images) await uploadImage(id, blob).catch((e) => toast(`Kuvaa ei tallennettu: ${e.message}`));
  loadImages();
});

// Click on the backdrop (outside the dialog box) closes the dialog. Both press and release must
// land on the backdrop, so selecting text and letting go outside does not close it.
for (const d of [dlg, detail, pdlg]) {
  let pressedOnBackdrop = false;
  d.addEventListener('mousedown', (ev) => { pressedOnBackdrop = ev.target === d; });
  d.addEventListener('click', (ev) => { if (ev.target === d && pressedOnBackdrop) d.close(); });
}

function addLive(e) {
  const box = document.getElementById('live');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  let text = '';
  if (e.kind === 'turn') text = `— vuoro ${e.turn} —`;
  else if (e.kind === 'tool') text = `${e.name}: ${e.summary}`;
  else if (e.kind === 'text') text = e.text;
  else if (e.kind === 'result') text = 'valmis';
  else if (e.kind === 'error') text = `virhe: ${e.message}`;
  else return;
  box.append(el('div', { textContent: text, className: e.kind === 'error' ? 'err' : '' }));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function loadRefine() {
  if (!openId) return;
  try {
    const r = await api(`/api/cards/${openId}/refine`);
    const c = allCards.find((x) => x.id === openId);
    const json = JSON.stringify([r, c?.status]);
    if (json === refineJson) return; // keep typed answers while nothing changed
    refineJson = json;
    if (c) setDetailMeta(c);
    renderRefine(r, c);
  } catch (e) { toast(e.message); }
}

/** The popup for a 409 "confirm first" answer (see ConfirmationError): refining before the dependency is ready. */
function confirmDependency(data, cardId) {
  const c = allCards.find((x) => x.id === cardId);
  const kind = data.afterKind === 'planned' ? 'sen suunnitelma on hyväksytty' : 'se on toteutettu (Done)';
  return confirmBox({
    title: 'Riippuvuus ei ole vielä valmis',
    text: `"${c?.title ?? 'Kortti'}" riippuu kortista "${data.blockedBy?.title}" (nyt ${LABELS[data.blockedBy?.status] ?? data.blockedBy?.status}), ja sen pitäisi odottaa, kunnes ${kind}.\n\nAloitetaanko tarkennus silti?`,
    ok: 'Aloita tarkennus',
  });
}

/** A step forward: the dialog closes so the board shows where the card went; what happened is told in the command log. */
function advanced(message) {
  const title = allCards.find((c) => c.id === openId)?.title ?? '';
  detail.close(); // the close handler refreshes the board
  reply(`${message}${title ? `: ${title}` : ''}`);
  loadNext();
}

const ACT_DONE = { 'refine/start': 'Tarkennus aloitettu', 'refine/answer': 'Vastaus lähetetty tarkentajalle', 'refine/approve': 'Suunnitelma hyväksytty, työ jonossa (Ready)', 'refine/retry': 'Tarkennus käynnistetty uudelleen' };

async function act(path, body) {
  let ok = false;
  try { await api(`/api/cards/${openId}/${path}`, { method: 'POST', body: body ?? {} }); ok = true; }
  catch (e) {
    if (e.status === 409 && e.data?.confirm && await confirmDependency(e.data, openId)) return act(path, { ...body, confirmed: true });
    if (e.status !== 409) toast(e.message);
  }
  if (ok) return advanced(ACT_DONE[path] ?? 'Tehty');
  await refresh(true);
  refineJson = '';
  await loadRefine();
}

function renderRefine(r, c) {
  const box = document.getElementById('d-refine');
  const parts = [];
  const canRefine = c && (c.status === 'inbox' || c.status === 'refining');

  if (r.state === 'running') {
    parts.push(el('section', {}, el('h3', { textContent: 'Tarkennus' }), el('div', { className: 'muted', textContent: `Käynnissä, vuoro ${r.turn}…` })));
  } else if (r.turn === 0 && canRefine) {
    const b = el('button', { className: 'primary', textContent: 'Aloita tarkennus' });
    b.addEventListener('click', () => act('refine/start'));
    parts.push(el('section', {}, el('h3', { textContent: 'Tarkennus' }), b));
  }

  if (r.state === 'error') {
    const b = el('button', { textContent: 'Yritä uudelleen' });
    b.addEventListener('click', () => act('refine/retry'));
    parts.push(el('section', {}, el('div', { className: 'err pre', textContent: r.error }), b));
  }

  if (r.summary) parts.push(el('section', {}, el('h3', { textContent: 'Yhteenveto' }), el('div', { textContent: r.summary })));

  if (r.state !== 'running' && r.questions.length) {
    const inputs = {};
    const sec = el('section', {}, el('h3', { textContent: 'Kysymykset' }));
    for (const q of r.questions) {
      const box_ = el('div', { className: 'q' }, el('div', { className: 'qt', textContent: q.text }));
      const custom = el('input', { type: 'text', placeholder: 'Oma vastaus (ylikirjoittaa valinnan)' });
      const radios = q.options.map((o) => {
        const rb = el('input', { type: 'radio', name: `q-${q.id}`, value: o.label, checked: o.label === q.recommended });
        const text = el('span', {}, o.label);
        if (o.label === q.recommended) text.append(el('span', { className: 'rec', textContent: ' (suositus)' }));
        if (o.description) text.append(el('small', { textContent: o.description }));
        box_.append(el('label', {}, rb, text));
        return rb;
      });
      box_.append(custom, micButton(custom));
      inputs[q.id] = () => custom.value.trim() || radios.find((x) => x.checked)?.value || '';
      sec.append(box_);
    }
    const send = el('button', { className: 'primary', textContent: 'Lähetä vastaukset' });
    send.addEventListener('click', () => act('refine/answer', { answers: Object.fromEntries(Object.entries(inputs).map(([k, f]) => [k, f()])) }));
    sec.append(send);
    parts.push(sec);
  }

  if (r.plan) parts.push(el('section', {}, el('h3', { textContent: 'Suunnitelma' }), el('div', { className: 'pre', textContent: r.plan })));

  if (r.state === 'idle' && r.turn > 0 && !r.questions.length) {
    const msg = el('textarea', { placeholder: 'Lisäviesti tarkentajalle (valinnainen)', style: 'min-height:60px;width:100%' });
    const more = el('button', { textContent: 'Lähetä viesti' });
    more.addEventListener('click', () => msg.value.trim() ? act('refine/answer', { message: msg.value }) : toast('Kirjoita viesti ensin'));
    parts.push(el('section', {}, msg, el('div', { className: 'actions' }, micButton(msg), more)));
  }

  if (r.plan && c?.status === 'refining' && r.state !== 'running') {
    const go = el('button', { className: 'primary', textContent: r.ready ? 'Start work' : 'Start work (pakota)' });
    go.addEventListener('click', async () => {
      if (!r.ready && !(await confirmBox({ title: 'Suunnitelma ei ole valmis', text: 'Tarkentajalla on vielä kysymyksiä auki. Aloitetaanko työ silti?', ok: 'Aloita työ' }))) return;
      act('refine/approve', { force: !r.ready });
    });
    parts.push(el('section', {}, el('div', { className: 'row' }, go)));
  }

  box.replaceChildren(...parts);
}

'use strict';
// the command field, the orchestrator and project conversations.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- command field: typed and spoken commands share one path, and follow-up questions ----
const cmdBox = document.getElementById('cmd');
const cmdLog = document.getElementById('cmd-log');
const cmdAsk = document.getElementById('cmd-ask');
const cmdInput = document.getElementById('cmd-input');
let pending = null; // { question, answer(text), project?, step?, retry? }: the next message answers it

/** A line in the command log. Kept on the server (except passing "Mietin…" lines), so it survives restarts. */
function chat(who, text, cls = '', { persist = true } = {}) {
  const line = el('div', { className: `${who} ${cls}`.trim(), textContent: text });
  cmdLog.append(line);
  while (cmdLog.children.length > 150) cmdLog.firstChild.remove();
  cmdLog.scrollTop = cmdLog.scrollHeight;
  if (persist && cls !== 'wait') {
    api('/api/chat', { method: 'POST', body: { who, text, error: cls === 'err' } }).catch(() => {}); // the log line is shown either way
  }
  return line;
}

async function restoreChat() {
  try {
    const past = await api('/api/chat?limit=120');
    if (!past.length) return;
    const now = [...cmdLog.children];
    cmdLog.replaceChildren();
    for (const m of past) chat(m.who, m.text, m.error ? 'err' : '', { persist: false });
    cmdLog.append(el('div', { className: 'bot wait', textContent: `— aiempi keskustelu (viimeisin ${stamp(past.at(-1).t)}) —` }), ...now);
    cmdLog.scrollTop = cmdLog.scrollHeight;
  } catch { /* an empty log is fine */ }
}

/** A reply in the log; with voice control on it also goes to the status line and, if `speak` is set, is read aloud. */
function reply(text, { error = false, speak: aloud = false } = {}) {
  chat('bot', text, error ? 'err' : '');
  if (voice.on) { say(text); if (aloud) speak(text); }
}

function ask(question, answer, opts = {}) {
  pending = { question, answer, ...opts };
  cmdAsk.textContent = `Odotan vastausta (ohita: "peruuta")`;
  reply(question, { speak: true });
}
function clearAsk() { pending = null; cmdAsk.textContent = ''; }

async function runCommand(raw, { byVoice = false } = {}) {
  const text = String(raw ?? '').trim().replace(/^\/+\s*/, ''); // "/komennot" out of chat habit works too
  if (!text) return;
  chat('me', text);

  if (pending) {
    const p = pending;
    clearAsk();
    if (isCancel(text)) { reply('Selvä, ohitetaan.'); return; }
    // A question about a project only stands while the project is still at that step (buttons may have moved it on).
    const fresh = p.project ? await api(`/api/projects/${encodeURIComponent(p.project)}`).catch(() => null) : null;
    if (!p.project || fresh?.step === p.step) {
      try { await p.answer(text); } catch (e) {
        reply(e.message, { error: true });
        if (p.retry) ask(p.question, p.answer, p);
      }
      return;
    }
  }

  const x = text.replace(/[.!?,]+$/, '');
  if (/^(uusi keskustelu|nollaa ohjaaja|unohda keskustelu|aloita alusta)$/i.test(x)) {
    await api('/api/orchestrator/reset', { method: 'POST', body: {} });
    reply('Aloitetaan puhdas keskustelu: ohjaaja ei muista aiempaa.');
    return;
  }
  const ctx = voiceContext();
  const action = interpret(x, ctx);
  if (!action) return askOrchestrator(text, ctx, byVoice); // anything the quick rules do not cover goes to the global agent
  let r;
  try { r = await perform(action); } catch (e) {
    reply(e.message, { error: true, speak: byVoice });
    if (byVoice) beep(false);
    return;
  }
  if (!r.ok) { reply('Ei onnistu juuri nyt.', { speak: byVoice }); return; }
  const label = r.label ?? describe(action, ctx);
  if (label) reply(label);
  if (byVoice) { if (r.speak) speak(r.speak); else beep(true); } // only answers worth hearing are spoken; the rest is a tone
}

// ---- the orchestrator: one global agent with its own memory, steering the board through its tools ----
function screenText(ctx) {
  let where = 'the board';
  if (ctx.state === 'detail') {
    const c = allCards.find((x) => x.id === openId);
    where = c ? `the detail dialog of card ${c.id} "${c.title}" (${c.status}) is open` : 'a card dialog is open';
  } else if (ctx.state === 'project') where = openProject ? `the dialog of project "${openProject}" (step ${openProjectData?.step ?? '?'}) is open` : 'the new-project form is open';
  else if (ctx.state === 'dialog') where = 'the new-card form is open';
  // What the person sees in "Sinun vuorosi", so "tee seuraava" means something to the orchestrator.
  const todo = (nextSteps?.yourTurn ?? []).slice(0, 6).map((x, i) => `${i + 1}. ${x.what}: ${x.title} [${x.card ?? x.project}] -> ${x.action}`).join(' | ');
  return todo ? `${where}. Their "Sinun vuorosi" list on screen: ${todo}` : where;
}

const TOOL_LABEL = {
  board_overview: 'katsoi taulun', next_steps: 'katsoi ehdotuslistan', get_card: 'luki kortin', list_repos: 'listasi repot', create_card: 'loi kortin', update_card: 'muokkasi korttia',
  move_card: 'siirsi korttia', start_refinement: 'aloitti tarkennuksen', answer_refinement: 'vastasi tarkentajalle', start_work: 'hyväksyi suunnitelman',
  answer_agent: 'vastasi agentille', stop_agent: 'pysäytti agentin', retry_agent: 'käynnisti agentin uudelleen', set_dispatcher: 'muutti ajoa',
  create_project: 'perusti projektin', get_project: 'luki projektin', delete_project: 'pyysi poistoa', plan_project: 'käynnisti suunnittelun', create_project_tasks: 'loi projektin kortit',
};

// What the person pressed in the orchestrator's popups, told to it with the next message.
let popupNotes = [];

async function askOrchestrator(text, ctx, byVoice) {
  const wait = chat('bot', 'Ohjaaja miettii…', 'wait');
  const notes = popupNotes;
  popupNotes = [];
  let out;
  try {
    out = await api('/api/orchestrator', { method: 'POST', body: { text: notes.length ? `[Popups since your last reply: ${notes.join(' ')}]\n${text}` : text, screen: screenText(ctx) } });
  } catch (e) {
    popupNotes = [...notes, ...popupNotes];
    reply(`Ohjaaja ei vastannut: ${e.message}`, { error: true, speak: byVoice });
    if (byVoice) beep(false);
    return;
  } finally { wait.remove(); }
  const did = [...new Set(out.tools.map((t) => TOOL_LABEL[t]).filter(Boolean))];
  if (did.length) chat('bot', `(${did.join(', ')})`, 'wait');
  reply(out.reply || '(ei vastausta)', { speak: byVoice });
  await refresh(true);
  for (const c of out.confirmations ?? []) await confirmFromOrchestrator(c);
  // What it changed shows up at once, also in an open dialog.
  await refresh(true);
  loadProjects();
  if (detail.open) { refineJson = ''; runJson = ''; loadRefine(); loadRun(); }
  if (pdlg.open && openProject) { projectJson = ''; loadProject(); }
}

/** A step the orchestrator could not take without the person's OK: ask with the popup, and on OK do it here. */
async function confirmFromOrchestrator(c) {
  if (c.tool === 'delete_project' && c.project) {
    const p = await api(`/api/projects/${encodeURIComponent(c.project)}`).catch(() => null);
    const done = p ? await deleteProject(p) : false;
    popupNotes.push(done ? `OK: project "${c.project}" deleted.` : `Cancel: project "${c.project}" was not deleted.`);
    return;
  }
  if (c.tool !== 'start_refinement' || !c.args?.id) return;
  const card = allCards.find((x) => x.id === c.args.id);
  if (!(await confirmDependency(c, c.args.id))) {
    popupNotes.push(`Cancel: did not start refining "${card?.title ?? c.args.id}".`);
    reply(`Selvä, ${card ? `"${card.title}"` : 'kortti'} odottaa.`);
    return;
  }
  try {
    await api(`/api/cards/${c.args.id}/refine/start`, { method: 'POST', body: { confirmed: true } });
    popupNotes.push(`OK: refining "${card?.title ?? c.args.id}" started.`);
    reply(`Tarkennus aloitettu: ${card?.title ?? c.args.id}`);
  } catch (e) {
    reply(e.message, { error: true });
  }
  await refresh(true);
}

// ---- conversations about projects ----
const whereSentence = (p) => `Lähdekoodi: git-repo ${p.path}` + (p.sourceControl.kind === 'local' ? ', ei etärepoa (vain tällä koneella).'
  : p.sourceControl.pushed ? `, etärepo GitHub ${p.sourceControl.fullName} (${p.sourceControl.private ? 'yksityinen' : 'julkinen'}).` : ', GitHub-repo ei vielä valmis.');

async function startNewProject(a) {
  if (!a.name) {
    return ask('Mikä projektin nimeksi tulee? (kirjaimet, numerot, - ja _)', (t) => startNewProject({ ...a, name: toProjectName(t) }), { retry: true });
  }
  if (!a.source) {
    return ask(`Missä projektin ${a.name} lähdekoodi säilytetään: paikallisesti tällä koneella vai GitHubissa? (paikallinen / github)`,
      (t) => startNewProject({ ...a, source: sourceFrom(t) ?? 'local', owner: a.owner ?? ownerFrom(t) }));
  }
  const busy = chat('bot', a.source === 'github' ? `Perustan projektin ${a.name} ja luon GitHub-repon…` : `Perustan projektin ${a.name}…`, 'wait');
  let p;
  try {
    p = await api('/api/projects', { method: 'POST', body: { name: a.name, sourceControl: a.source === 'github' ? { kind: 'github', owner: a.owner ?? '' } : { kind: 'local' } } });
  } finally { busy.remove(); }
  loadProjects();
  openProjectDialog(p.name);
  reply(`Projekti ${p.name} perustettu. ${whereSentence(p)}`);
  followProject(p);
}

async function projectCommand(name, path, body) {
  if (!name) throw new Error('Avaa ensin projekti.');
  const p = await api(`/api/projects/${encodeURIComponent(name)}/${path}`, { method: 'POST', body });
  if (openProject === p.name) { projectJson = ''; showProject(p); }
  loadProjects();
  if (path === 'tasks') refresh(true);
  if (path === 'source-control' && p.step !== 'remote') reply(`${p.name}: ${whereSentence(p)}`);
  followProject(p);
  return p;
}

/** The tasks ticked in the open project dialog, or all of them. */
function chosenTasks(name) {
  const boxes = openProject === name ? [...document.querySelectorAll('#p-body .task input[type=checkbox]')] : [];
  return boxes.length ? boxes.filter((b) => b.checked).map((b) => Number(b.value)) : undefined;
}

/** Says where the project stands and asks for what it needs next. */
function followProject(p) {
  const s = p.planning;
  const sc = p.sourceControl;
  const at = { project: p.name, step: p.step };
  if (p.step === 'remote') {
    reply(`GitHub-vaihe jäi kesken: ${sc.error ?? 'main-haaraa ei ole pushattu'}`, { error: true });
    ask(sc.fullName ? 'Yritetäänkö pushia uudelleen? (kyllä / peruuta)' : 'Yritetäänkö GitHubia uudelleen vai jatketaanko paikallisena? (uudelleen / paikallinen)',
      (t) => (!sc.fullName && sourceFrom(t) === 'local'
        ? projectCommand(p.name, 'source-control', { sourceControl: { kind: 'local' } })
        : projectCommand(p.name, 'source-control', {})), at);
  } else if (p.step === 'describe') {
    if (s.error) reply(`Suunnittelu epäonnistui: ${s.error}`, { error: true });
    ask(`Kuvaile projekti ${p.name}: mitä rakennetaan, kenelle ja millä tekniikoilla? Mitä jätetään pois?`,
      (t) => projectCommand(p.name, 'plan', { description: t }), { ...at, retry: true });
  } else if (p.step === 'planning') {
    reply('Teen suunnitelmaa. Kerron täällä, kun se on valmis (yleensä muutama minuutti).');
    watchProject(p.name);
  } else if (p.step === 'review') {
    if (s.error) reply(`Viimeisin päivitys epäonnistui: ${s.error}`, { error: true });
    reply(`Suunnitelma valmis: ${s.summary}\n${s.tasks.map((t, i) => `${i + 1}. ${t.title}${t.after != null ? ` (odottaa: ${[t.after, ...(t.alsoAfter ?? [])].map((n) => n + 1).join(', ')})` : ''}`).join('\n')}\nKoko suunnitelma on projektin ikkunassa.`);
    ask('Luodaanko kortit? Vastaa "luo kortit", tai kirjoita mitä suunnitelmassa muutetaan.',
      (t) => (isApproval(t) ? projectCommand(p.name, 'tasks', { tasks: chosenTasks(p.name) }) : projectCommand(p.name, 'plan', { feedback: t })), at);
  } else {
    reply(`Valmis: suunnitelma on tiedostossa PLAN.md ja Inboxiin luotiin ${p.cards.length} korttia. Avaa kortti ja aloita tarkennus, niin se etenee tavalliseen tapaan.`, { speak: true });
  }
}

/** Follows a planning run in the background and picks the conversation up when it ends. */
const watching = new Set();
function watchProject(name) {
  if (watching.has(name)) return;
  watching.add(name);
  const tick = async () => {
    let p;
    try { p = await api(`/api/projects/${encodeURIComponent(name)}`); } catch (e) { watching.delete(name); reply(e.message, { error: true }); return; }
    if (p.step === 'planning') { setTimeout(tick, 3000); return; }
    watching.delete(name);
    followProject(p);
  };
  setTimeout(tick, 3000);
}

// The chat lives in the docked panel on the right, and moves into whichever dialog is open: a modal dialog makes the rest of the page inert.
function dockCommandBar() {
  const target = [pdlg, detail, dlg].find((d) => d.open) ?? document.getElementById('chat-dock');
  if (cmdBox.parentElement !== target) target.append(cmdBox);
  cmdLog.scrollTop = cmdLog.scrollHeight;
}
const dockObserver = new MutationObserver(dockCommandBar);
for (const d of [dlg, detail, pdlg]) dockObserver.observe(d, { attributes: true, attributeFilter: ['open'] });

document.getElementById('cmd-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = cmdInput.value;
  cmdInput.value = '';
  await runCommand(text);
  cmdInput.focus();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
  ev.preventDefault();
  (document.body.dataset.view === 'sandbox' ? document.getElementById('sb-input') : cmdInput).focus(); // the sandbox has its own chat
});

function runVoiceCommand(raw) {
  gate.touch();
  keepButtonFresh();
  return runCommand(raw, { byVoice: true });
}

// A final transcript goes through the wake-word gate first: with the wake word on, speech that does not
// start with "agentti" (or follow a command within the window) is ignored, unless a question is waiting for an answer.
function handleUtterance(raw) {
  if (voice.dictating) { handleDictation(raw); return; } // dictation needs neither the wake word nor a command
  const text = voice.wake ? gate.accept(raw) ?? (pending ? raw : null) : raw;
  if (text === null) return;
  keepButtonFresh();
  if (!text.trim()) { say('Kuuntelen. Sano komento.'); beep(true); return; }
  runVoiceCommand(text);
}

function setVoiceButton() {
  const awake = voice.on && voice.wake && gate.isOpen();
  vbtn.textContent = !voice.on ? '🎤 Puheohjaus: pois' : awake ? '🎤 Kuuntelen komentoa…' : voice.wake ? '🎤 Sano "agentti"' : '🎤 Puheohjaus: päällä';
  vbtn.classList.toggle('on', voice.on);
  document.body.classList.toggle('voice-on', voice.on);
  wakeBtn.textContent = voice.wake ? '🔔 Herätesana: agentti' : '🔔 Herätesana: pois';
  wakeBtn.classList.toggle('on', voice.wake);
  ttsBtn.textContent = voice.tts ? '🔊 Äänivastaus: päällä' : '🔇 Äänivastaus: pois';
  ttsBtn.classList.toggle('on', voice.tts);
}
// The button shows "listening" while the wake window is open, so refresh it when the window closes.
function keepButtonFresh() {
  setVoiceButton();
  clearTimeout(btnTimer);
  btnTimer = setTimeout(setVoiceButton, 10_200);
}

// Hints for the recogniser (Chrome's on-device recognition supports them; elsewhere this is a no-op): the wake word,
// card titles and repo names are exactly what it would otherwise mishear.

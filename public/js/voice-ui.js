'use strict';
// voice dictation, global voice control and perform().
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- voice dictation (browser speech recognition, Finnish) ----
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
function micButton(target) {
  if (!SpeechRec) return document.createComment('speech recognition not supported');
  const b = el('button', { type: 'button', className: 'mic', title: 'Sanele suomeksi (paina uudelleen lopettaaksesi)', textContent: '🎤' });
  let rec = null;
  b.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SpeechRec();
    rec.lang = 'fi-FI';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (!ev.results[i].isFinal) continue;
        const text = ev.results[i][0].transcript.trim();
        target.value = target.value.trim() ? `${target.value.trim()} ${text}` : text;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    rec.onerror = (e) => toast('Puheentunnistus: ' + (e.error === 'not-allowed' ? 'selain esti mikrofonin käytön. Salli mikrofoni osoiterivin kuvakkeesta.' : e.error));
    rec.onend = () => { rec = null; b.classList.remove('on'); };
    b.classList.add('on');
    rec.start();
  });
  return b;
}
for (const id of ['f-title', 'f-brief']) {
  const field = document.getElementById(id);
  field.after(micButton(field));
}


// ---- global voice control ----
// Parsing lives in /voice.js (testable without a browser). Here: listening, wake word, spoken replies, and doing things in the page.
const voice = { on: false, rec: null, wake: true, tts: true, speaking: false, muteUntil: 0, dictating: null };
const gate = createWakeGate();
const vstatus = document.getElementById('voice-status');
const vbtn = document.getElementById('voice-toggle');
const wakeBtn = document.getElementById('wake-toggle');
const ttsBtn = document.getElementById('tts-toggle');
let vtimer = null;
let btnTimer = null;

function pref(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } }
function savePref(key, on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage unavailable: fine */ } }
voice.wake = pref('ac_wake', true);
voice.tts = pref('ac_tts', true);

function say(msg, ms = 7000) {
  vstatus.textContent = msg;
  clearTimeout(vtimer);
  if (msg) vtimer = setTimeout(() => { vstatus.textContent = ''; }, ms);
}

// Spoken replies. The recogniser would hear them, so results are dropped while speaking and briefly after.
function speak(text) {
  if (!voice.tts || !text || !('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  const fi = voices.find((v) => v.lang?.toLowerCase().startsWith('fi'));
  if (voices.length && !fi) return; // no Finnish voice installed: stay silent rather than read Finnish with an English one
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\s*\(([^)]*)\)/g, '. $1').replace(/^./, (c) => c.toUpperCase()));
  u.lang = 'fi-FI';
  if (fi) u.voice = fi;
  const end = () => { voice.speaking = false; voice.muteUntil = Date.now() + 600; };
  u.onend = end;
  u.onerror = end;
  voice.speaking = true;
  speechSynthesis.speak(u);
}

// A short tone instead of a spoken "done": faster, and less to talk over. Only problems and answers are spoken.
let audioCtx = null;
function beep(ok = true) {
  if (!voice.tts) return;
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 880 : 330;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.16);
    voice.muteUntil = Date.now() + 400;
  } catch { /* no audio: the status line still shows the result */ }
}

// Dictation: after "sanele kuvaus" everything heard goes into the field until "valmis" (or 30 s of silence).
const DICTATION = {
  brief: { open: () => dlg.open, append: (t) => setField('f-brief', t, true), name: 'kuvaus' },
  answer: {
    open: () => detail.open && detail.querySelector('#d-run textarea'),
    append: (t) => { const box = detail.querySelector('#d-run textarea'); box.value = box.value.trim() ? `${box.value.trim()} ${t}` : t; },
    name: 'vastaus',
  },
};
let dictTimer = null;
function endDictation(msg) {
  if (!voice.dictating) return;
  voice.dictating = null;
  clearTimeout(dictTimer);
  if (msg) say(msg);
  beep(true);
}
function startDictation(kind) {
  voice.dictating = kind;
  clearTimeout(dictTimer);
  dictTimer = setTimeout(() => endDictation('Sanelu päättyi (hiljaisuus)'), 30_000);
}
function handleDictation(raw) {
  const d = DICTATION[voice.dictating];
  if (!d.open()) { endDictation(); return; }
  gate.touch();
  keepButtonFresh();
  if (isDictationEnd(raw)) { endDictation(`${d.name} valmis`); return; }
  d.append(raw.trim());
  say(`Sanelu: "${raw.trim()}" (sano "valmis" lopuksi)`, 30_000);
  startDictation(voice.dictating);
}

function clickIn(root, re) {
  const b = [...root.querySelectorAll('button')].find((x) => re.test(x.textContent.trim()) && !x.disabled);
  if (b) b.click();
  return Boolean(b);
}

function setField(id, text, append = false) {
  const f = document.getElementById(id);
  f.value = append && f.value.trim() ? `${f.value.trim()} ${text}` : text;
  f.dispatchEvent(new Event('input', { bubbles: true }));
}

function voiceContext() {
  const state = pdlg.open ? 'project' : dlg.open ? 'dialog' : detail.open ? 'detail' : 'main';
  const p = state === 'project' ? openProjectData : null;
  return {
    state,
    cards: cards.map((c) => ({ id: c.id, title: c.title, status: c.status })),
    dispatcher: dispatcher ? { enabled: dispatcher.enabled } : null,
    buttons: state === 'detail' ? [...detail.querySelectorAll('button')].filter((b) => !b.disabled).map((b) => b.textContent.trim()) : undefined,
    hasAnswerBox: Boolean(detail.querySelector('#d-run textarea')),
    repos: [...document.querySelectorAll('#repo-list button')].map((b) => b.textContent),
    projects: projects.map((x) => ({ name: x.name, step: x.step, local: x.sourceControl.kind === 'local' })),
    project: p ? { name: p.name, step: p.step, local: p.sourceControl.kind === 'local' } : undefined,
  };
}

function readQuestion() {
  const texts = [];
  for (const h of detail.querySelectorAll('h3')) if (h.textContent === 'Agentin kysymys' && h.nextElementSibling) texts.push(h.nextElementSibling.textContent);
  for (const q of detail.querySelectorAll('.q .qt')) texts.push(q.textContent);
  return texts.join(' ');
}

/**
 * Does what the action says in the page. Resolves to { ok, label?, speak? }; ok=false when it cannot be done
 * right now. Throws (with a message for the person) when a server call fails.
 */
async function perform(a) {
  switch (a.action) {
    case 'new_card': document.getElementById('new').click(); return { ok: true };
    case 'open_card': if (!allCards.some((c) => c.id === a.id)) return { ok: false }; openDetail(a.id); return { ok: true };
    case 'move_card':
      if (!allCards.some((c) => c.id === a.id)) return { ok: false };
      await api(`/api/cards/${a.id}`, { method: 'PATCH', body: { status: a.status } });
      await refresh(true);
      return { ok: true, label: `${a.title ?? 'Kortti'} → ${LABELS[a.status] ?? a.status}` };
    case 'close':
      if (pdlg.open) pdlg.close(); else if (dlg.open) dlg.close(); else if (detail.open) detail.close(); else return { ok: false };
      return { ok: true };
    case 'refresh': refresh(true); return { ok: true };
    case 'pause_dispatch': case 'resume_dispatch':
      if (!dispatcher || dispatcher.enabled !== (a.action === 'pause_dispatch')) return { ok: false };
      document.getElementById('disp-toggle').click();
      return { ok: true };
    case 'help': return { ok: true, label: VOICE_HELP, speak: 'Komennot näkyvät ruudulla' }; // reply() also shows it on the voice status line
    case 'new_project': await startNewProject(a); return { ok: true, label: '' };
    case 'open_project':
      if (!projects.some((p) => p.name === a.name)) return { ok: false };
      openProjectDialog(a.name);
      followProject(await api(`/api/projects/${encodeURIComponent(a.name)}`));
      return { ok: true, label: '' };
    case 'delete_project': {
      const p = await api(`/api/projects/${encodeURIComponent(a.name)}`).catch(() => null);
      if (!p) return { ok: false };
      await deleteProject(p);
      return { ok: true, label: '' };
    }
    case 'describe_project': await projectCommand(openProject, 'plan', { description: a.text }); return { ok: true, label: '' };
    case 'plan_feedback': await projectCommand(openProject, 'plan', { feedback: a.text }); return { ok: true, label: '' };
    case 'create_tasks': await projectCommand(openProject, 'tasks', { tasks: chosenTasks(openProject) }); return { ok: true, label: '' };
    case 'publish_github': await projectCommand(openProject, 'source-control', { sourceControl: { kind: 'github', owner: a.owner ?? '' } }); return { ok: true, label: '' };
    case 'retry_github': await projectCommand(openProject, 'source-control', {}); return { ok: true, label: '' };
    case 'keep_local': await projectCommand(openProject, 'source-control', { sourceControl: { kind: 'local' } }); return { ok: true, label: '' };
    case 'stop_listening': stopVoice(); return { ok: true };
    case 'quiet': try { speechSynthesis.cancel(); } catch { /* not supported */ } voice.speaking = false; return { ok: true, speak: '' };
    case 'noop': return { ok: true };
    case 'submit': document.getElementById('form').requestSubmit(); return { ok: true };
    case 'set_title': setField('f-title', a.text); return { ok: true };
    case 'append_brief': setField('f-brief', a.text, true); return { ok: true };
    case 'set_repos': setField('f-repos', a.names.join(', ')); paintRepoChips(); return { ok: true };
    case 'set_priority': document.getElementById('f-priority').value = a.value; return { ok: true };
    case 'dictate_brief': if (!dlg.open) return { ok: false }; startDictation('brief'); return { ok: true, speak: '' };
    case 'dictate_answer': if (!DICTATION.answer.open()) return { ok: false }; startDictation('answer'); return { ok: true, speak: '' };
    case 'set_answer': {
      const box = detail.querySelector('#d-run textarea');
      if (!box) return { ok: false };
      box.value = box.value.trim() ? `${box.value.trim()} ${a.text}` : a.text;
      return { ok: true };
    }
    case 'read_question': {
      const q = readQuestion();
      return q ? { ok: true, speak: q } : { ok: false };
    }
    default:
      if (DETAIL_BUTTONS[a.action]) return { ok: clickIn(detail, DETAIL_BUTTONS[a.action]) };
      return { ok: false };
  }
}

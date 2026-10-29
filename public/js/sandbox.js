'use strict';
// #/sandbox: a project's brainstorming chat and drawing canvas.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

const SB_COLORS = [['#111827', 'Musta'], ['#DC2626', 'Punainen'], ['#2563EB', 'Sininen'], ['#16A34A', 'Vihreä']];
const SB_WIDTHS = [[4, 'Ohut'], [10, 'Paksu']]; // in thousandths of the canvas width, so a drawing looks the same at any size
const SB_ERASER = 24;
const SB_SHARE_WIDTH = 1600; // the PNG the AI gets is at most this wide
const sbCanvas = document.getElementById('sb-canvas');
const sbLog = document.getElementById('sb-log');
const sbInput = document.getElementById('sb-input');
const sbSelect = document.getElementById('sb-project');
const sbdlg = document.getElementById('sbdlg');
const sb = {
  project: null, strokes: [], current: null, color: SB_COLORS[0][0], width: SB_WIDTHS[0][0], erase: false,
  saveTimer: null, saving: Promise.resolve(), version: 0, savedVersion: 0, rev: 0, chatJson: '', chat: [], busy: false, sending: false, notes: [],
};
const sbPath = (rest = '') => `/api/sandbox/${encodeURIComponent(sb.project)}${rest}`;

// ---- drawing: strokes as vectors, x and y as fractions of the canvas ----
function sbDrawStroke(ctx, s, w, h, from = 0) {
  const pts = s.points;
  ctx.save();
  ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = s.color;
  ctx.lineWidth = (s.width * w) / 1000;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const start = pts[Math.max(0, from - 1)];
  ctx.moveTo(start[0] * w, start[1] * h);
  if (pts.length === 1) ctx.lineTo(start[0] * w + 0.01, start[1] * h); // a dot
  for (let i = Math.max(1, from); i < pts.length; i++) ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
  ctx.stroke();
  ctx.restore();
}

/** Sizes the canvas to its box (sharp on high-DPI screens) and draws every stroke again. */
function sbRedraw() {
  const r = sbCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (!w || !h) return;
  if (sbCanvas.width !== w || sbCanvas.height !== h) { sbCanvas.width = w; sbCanvas.height = h; }
  const ctx = sbCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  for (const s of sb.strokes) sbDrawStroke(ctx, s, w, h);
}
new ResizeObserver(sbRedraw).observe(sbCanvas);

function sbPoint(ev) {
  const r = sbCanvas.getBoundingClientRect();
  const round = (v) => Math.round(v * 1e4) / 1e4;
  return [round((ev.clientX - r.left) / r.width), round((ev.clientY - r.top) / r.height)];
}

sbCanvas.addEventListener('pointerdown', (ev) => {
  if (!sb.project || ev.button !== 0) return;
  sbCanvas.setPointerCapture(ev.pointerId);
  sb.current = { color: sb.erase ? '#000000' : sb.color, width: sb.erase ? SB_ERASER : sb.width, ...(sb.erase ? { erase: true } : {}), points: [sbPoint(ev)] };
  sb.strokes.push(sb.current);
  sbDrawStroke(sbCanvas.getContext('2d'), sb.current, sbCanvas.width, sbCanvas.height);
});
sbCanvas.addEventListener('pointermove', (ev) => {
  if (!sb.current) return;
  const p = sbPoint(ev);
  const last = sb.current.points.at(-1);
  if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.002) return; // keep the saved drawing small
  sb.current.points.push(p);
  sbDrawStroke(sbCanvas.getContext('2d'), sb.current, sbCanvas.width, sbCanvas.height, sb.current.points.length - 1);
});
const sbEndStroke = () => { if (sb.current) { sb.current = null; sbScheduleSave(); } };
sbCanvas.addEventListener('pointerup', sbEndStroke);
sbCanvas.addEventListener('pointercancel', sbEndStroke);

/** The canvas is saved shortly after drawing stops, so it survives a reload. Saving never sends it to the AI. */
// `version` counts the changes made here and `savedVersion` the last one the server has, so "unsaved" is exact
// even while a save is on its way; `rev` is the server's count of the drawing it holds.
const sbUnsaved = () => sb.version !== sb.savedVersion;
function sbScheduleSave() {
  sb.version++;
  clearTimeout(sb.saveTimer);
  document.getElementById('sb-saved').textContent = 'Tallentamatta…';
  sb.saveTimer = setTimeout(sbSaveNow, 800);
}
function sbSaveNow() {
  clearTimeout(sb.saveTimer);
  sb.saveTimer = null;
  const project = sb.project, version = sb.version, strokes = sb.strokes.map((s) => ({ ...s }));
  sb.saving = sb.saving.then(async () => {
    try {
      const { rev } = await api(`/api/sandbox/${encodeURIComponent(project)}/canvas`, { method: 'PUT', body: { strokes } });
      if (project !== sb.project) return;
      sb.rev = rev;
      sb.savedVersion = Math.max(sb.savedVersion, version);
      if (!sbUnsaved()) document.getElementById('sb-saved').textContent = `Piirros tallennettu ${stamp(new Date().toISOString()).split(' ')[1]}`;
    } catch (e) { toast(`Piirroksen tallennus epäonnistui: ${e.message}`); }
  });
  return sb.saving;
}

// A drawing that was not saved when the page went away (reload or close within the save delay, or a save still on
// its way) is kept in this browser and put back on the next load, unless the server has changed it since.
const SB_DRAFT = 'ac_sandbox_draft';
function sbKeepDraft() {
  if (!sb.project || !sbUnsaved()) return;
  try { localStorage.setItem(SB_DRAFT, JSON.stringify({ project: sb.project, baseRev: sb.rev, strokes: sb.strokes })); } catch { /* storage full or unavailable */ }
}
function sbTakeDraft(project, rev) {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(SB_DRAFT) ?? 'null'); } catch { /* unreadable: none */ }
  if (draft?.project !== project) return null;
  try { localStorage.removeItem(SB_DRAFT); } catch { /* storage unavailable */ }
  // rev may be one ahead when the last save did reach the server: then the draft is that same drawing.
  return Array.isArray(draft.strokes) && rev <= draft.baseRev + 1 ? draft.strokes : null;
}

function sbTools() {
  const pick = (b, on) => b.setAttribute('aria-pressed', String(on));
  const colors = SB_COLORS.map(([c, label]) => {
    const b = el('button', { type: 'button', className: 'sb-color', title: label, ariaLabel: label });
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => { sb.color = c; sb.erase = false; sbTools(); });
    pick(b, !sb.erase && sb.color === c);
    return b;
  });
  const widths = SB_WIDTHS.map(([w, label]) => {
    const b = el('button', { type: 'button', textContent: label });
    b.addEventListener('click', () => { sb.width = w; sb.erase = false; sbTools(); });
    pick(b, !sb.erase && sb.width === w);
    return b;
  });
  document.getElementById('sb-colors').replaceChildren(...colors);
  document.getElementById('sb-widths').replaceChildren(...widths);
  pick(document.getElementById('sb-erase'), sb.erase);
  sbCanvas.classList.toggle('erasing', sb.erase);
}
document.getElementById('sb-erase').addEventListener('click', () => { sb.erase = !sb.erase; sbTools(); });
function sbUndo() {
  if (!sb.strokes.length) return;
  sb.strokes.pop();
  sbRedraw();
  sbScheduleSave();
}
document.getElementById('sb-undo').addEventListener('click', sbUndo);
document.addEventListener('keydown', (ev) => {
  if (document.body.dataset.view !== 'sandbox' || !(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z') return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
  ev.preventDefault();
  sbUndo();
});
document.getElementById('sb-clear').addEventListener('click', async () => {
  if (!sb.project || !sb.strokes.length) return;
  if (!(await confirmBox({ title: 'Tyhjennä piirros', text: 'Tyhjennetäänkö koko piirros? Tekoälylle jo näytetyt kuvat säilyvät keskustelussa.', ok: 'Tyhjennä', danger: true }))) return;
  clearTimeout(sb.saveTimer);
  sb.saveTimer = null;
  await sb.saving;
  try {
    const { rev } = await api(sbPath('/canvas'), { method: 'DELETE' });
    sb.strokes = [];
    sb.rev = rev;
    sb.savedVersion = ++sb.version; // the empty drawing is what the server has
    document.getElementById('sb-saved').textContent = '';
    sbRedraw();
  } catch (e) { toast(e.message); }
});

/** The drawing as a PNG on white, at most SB_SHARE_WIDTH wide (the eraser cuts through strokes, never the paper). */
function sbPng() {
  const r = sbCanvas.getBoundingClientRect();
  const w = Math.min(SB_SHARE_WIDTH, Math.round(r.width * (window.devicePixelRatio || 1)));
  const h = Math.round((w * r.height) / r.width);
  const layer = Object.assign(document.createElement('canvas'), { width: w, height: h });
  for (const s of sb.strokes) sbDrawStroke(layer.getContext('2d'), s, w, h);
  const out = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(layer, 0, 0);
  return new Promise((resolve, reject) => out.toBlob(async (blob) => {
    if (!blob) return reject(new Error('Kuvan muodostus epäonnistui'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    resolve(btoa(bin));
  }, 'image/png'));
}

// ---- the conversation ----
function sbLine(m) {
  if (m.sep) return el('div', { className: 'sep', textContent: m.text });
  const line = el('div', { className: `${m.who}${m.error ? ' err' : ''}` });
  if (m.image) {
    const src = sbPath(`/image/${m.image}`);
    line.append(el('a', { href: src, target: '_blank', rel: 'noopener', title: 'Tekoälylle näytetty piirros' }, el('img', { src, alt: 'Jaettu piirros', className: 'sb-thumb' })));
  }
  line.append(el('span', { textContent: m.text }));
  return line;
}

function sbRenderChat() {
  const rows = sb.chat.map(sbLine);
  if (sb.busy || sb.sending) rows.push(el('div', { className: 'bot wait', textContent: 'Sandbox miettii…' }));
  if (!rows.length) rows.push(el('div', { className: 'empty', textContent: 'Ei vielä viestejä. Kerro idea, kysy projektista tai piirrä ja näytä piirros tekoälylle.' }));
  const atBottom = sbLog.scrollHeight - sbLog.scrollTop - sbLog.clientHeight < 40;
  sbLog.replaceChildren(...rows);
  if (atBottom || sb.sending) sbLog.scrollTop = sbLog.scrollHeight;
}

/** The project's chat (and, when `withCanvas`, its drawing) from the server; the chat only re-renders when it changed. */
async function sbLoad({ withCanvas = false } = {}) {
  if (!sb.project) return;
  const project = sb.project;
  if (withCanvas) await sb.saving; // a save on its way lands first, so the drawing read back is never older than it
  let state;
  try { state = await api(sbPath()); } catch (e) { if (withCanvas) toast(e.message); return; }
  if (project !== sb.project) return;
  // Only when nothing drawn here is waiting to be saved: the server copy must never overwrite newer strokes.
  if (withCanvas && !sbUnsaved() && !sb.current) {
    const draft = sbTakeDraft(project, state.canvas.rev);
    sb.rev = state.canvas.rev;
    sb.strokes = draft ?? state.canvas.strokes;
    sbRedraw();
    document.getElementById('sb-saved').textContent = '';
    if (draft) sbScheduleSave(); // what was drawn just before the page went away
  }
  document.getElementById('sb-cost').textContent = state.turns ? `${state.turns} vastausta · $${state.cost.toFixed(2)}` : '';
  const json = JSON.stringify([state.chat, state.busy]);
  if (json === sb.chatJson) return;
  sb.chatJson = json;
  sb.chat = state.chat;
  sb.busy = state.busy;
  sbRenderChat();
}

const sbLastImage = () => [...sb.chat].reverse().find((m) => m.image)?.image ?? null;

/** Sends a message, or with `png` the drawing; then the cards the AI proposed are asked about in popups. */
async function sbSend(text, png = null) {
  if (!sb.project || sb.sending) return;
  const notes = sb.notes;
  sb.notes = [];
  sb.sending = true;
  sb.chat = [...sb.chat, { who: 'me', text: text || 'Katso piirrostani.' }];
  sbRenderChat();
  const project = sb.project;
  let out = null;
  try {
    out = await api(sbPath(png ? '/share' : '/chat'), { method: 'POST', body: { text, notes: notes.join(' '), ...(png ? { png } : {}) } });
  } catch (e) {
    sb.notes = [...notes, ...sb.notes];
    if (e.status === 400) toast(e.message); // nothing reached the AI; other failures are in the chat log
  } finally { sb.sending = false; }
  if (project !== sb.project) return;
  sb.chatJson = '';
  await sbLoad();
  for (const c of out?.confirmations ?? []) await sbConfirmCard(c.args ?? {});
  // Back to typing. A closed popup hands focus back to the field without a caret, so focus it afresh.
  if (sbInView() && !document.querySelector('dialog[open]') && [sbInput, document.body].includes(document.activeElement)) { sbInput.blur(); sbInput.focus(); }
}

/** A card the AI proposed: created only when the person presses OK. */
async function sbConfirmCard({ title, description, attachCanvas }) {
  if (!title) return;
  const image = attachCanvas ? sbLastImage() : null;
  const ok = await confirmBox({ title: `Luodaanko kortti: ${title}?`, text: `${description ?? ''}${image ? '\n\nKorttiin liitetään viimeisin tekoälylle näytetty piirros.' : ''}`, ok: 'Luo kortti' });
  if (!ok) { sb.notes.push(`Cancel: card "${title}" was not created.`); return; }
  try {
    const card = await api(sbPath('/card'), { method: 'POST', body: { title, description, ...(image ? { image } : {}) } });
    sb.notes.push(`OK: card "${title}" created in the Inbox.`);
    toast(`Kortti luotu Inboxiin: ${card.title}${card.attachError ? ` (piirrosta ei saatu liitettyä: ${card.attachError})` : ''}`);
    await refresh(true);
  } catch (e) { toast(e.message); }
}

document.getElementById('sb-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = sbInput.value.trim();
  if (!text || sb.sending) return;
  sbInput.value = '';
  sbSend(text);
});
sbInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); document.getElementById('sb-form').requestSubmit(); }
});
document.getElementById('sb-share').addEventListener('click', async () => {
  if (!sb.project || sb.sending) return;
  if (!sb.strokes.length) { toast('Piirrä ensin jotain.'); return; }
  let png;
  try { png = await sbPng(); } catch (e) { toast(e.message); return; }
  if (sb.saveTimer) sbSaveNow();
  const text = sbInput.value.trim();
  sbInput.value = '';
  sbSend(text, png);
});
document.getElementById('sb-reset').addEventListener('click', async () => {
  if (!sb.project) return;
  if (!(await confirmBox({ title: 'Uusi keskustelu', text: 'Tekoäly unohtaa tämän projektin aiemman keskustelun. Loki ja piirros säilyvät.', ok: 'Aloita alusta' }))) return;
  try { await api(sbPath('/reset'), { method: 'POST', body: {} }); } catch (e) { toast(e.message); }
  sb.chatJson = '';
  sbLoad();
});

// "Luo kortti": the person's own card, with the last shared drawing if they want it.
document.getElementById('sb-card').addEventListener('click', () => {
  if (!sb.project) return;
  const image = sbLastImage();
  document.getElementById('sb-ctitle').value = '';
  document.getElementById('sb-cdesc').value = '';
  const box = document.getElementById('sb-cimage');
  box.checked = Boolean(image);
  box.disabled = !image;
  document.getElementById('sb-cimage-row').title = image ? '' : 'Tekoälylle ei ole vielä näytetty piirrosta.';
  document.getElementById('sb-cerror').textContent = '';
  sbdlg.showModal();
});
document.getElementById('sb-ccancel').addEventListener('click', () => sbdlg.close());
document.getElementById('sb-cform').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const image = document.getElementById('sb-cimage').checked ? sbLastImage() : null;
  try {
    const card = await api(sbPath('/card'), { method: 'POST', body: { title: document.getElementById('sb-ctitle').value, description: document.getElementById('sb-cdesc').value, ...(image ? { image } : {}) } });
    sbdlg.close();
    toast(`Kortti luotu Inboxiin: ${card.title}${card.attachError ? ` (piirrosta ei saatu liitettyä: ${card.attachError})` : ''}`);
    await refresh(true);
  } catch (e) { document.getElementById('sb-cerror').textContent = e.message; }
});

// ---- the project ----
function sbSetEnabled(on) {
  for (const id of ['sb-erase', 'sb-undo', 'sb-clear', 'sb-share', 'sb-reset', 'sb-card']) document.getElementById(id).disabled = !on;
  sbInput.disabled = !on;
  document.querySelector('#sb-form button').disabled = !on;
}

async function sbSelectProject(name) {
  if (sb.saveTimer) sbSaveNow(); // the drawing in progress goes to the project it was drawn in
  await sb.saving;
  sb.project = name || null;
  sb.chatJson = '';
  sb.chat = [];
  sb.strokes = [];
  sb.notes = [];
  sb.version = sb.savedVersion = sb.rev = 0; // a failed save stays with the project it was for
  sbRedraw();
  sbSetEnabled(Boolean(sb.project));
  try { if (sb.project) localStorage.setItem('ac_sandbox', sb.project); } catch { /* storage unavailable: not remembered */ }
  if (!sb.project) { sbLog.replaceChildren(el('div', { className: 'empty', textContent: 'Ei projekteja. Lisää ensin projekti, niin voit ideoida sitä täällä.' })); return; }
  await sbLoad({ withCanvas: true });
}
sbSelect.addEventListener('change', () => sbSelectProject(sbSelect.value));

async function sbEnter() {
  let list = [];
  try { list = await api('/api/projects'); } catch (e) { toast(e.message); }
  const names = list.map((p) => p.name).sort((a, b) => a.localeCompare(b));
  let remembered = null;
  try { remembered = localStorage.getItem('ac_sandbox'); } catch { /* storage unavailable */ }
  const chosen = names.includes(sb.project) ? sb.project : names.includes(remembered) ? remembered : names[0] ?? null;
  sbSelect.replaceChildren(...names.map((n) => el('option', { value: n, textContent: n })));
  sbSelect.disabled = !names.length;
  if (chosen) sbSelect.value = chosen;
  if (chosen !== sb.project || !sb.project) await sbSelectProject(chosen);
  else await sbLoad({ withCanvas: true });
}

sbTools();
sbSetEnabled(false);
const sbInView = () => document.body.dataset.view === 'sandbox';
window.addEventListener('hashchange', () => { if (sbInView()) sbEnter(); else if (sb.saveTimer) sbSaveNow(); });
if (sbInView()) sbEnter();
setInterval(() => { if (sbInView() && !document.hidden && !sb.sending) sbLoad(); }, 3000);
// Leaving the page with unsaved strokes: they are kept in this browser (put back on the next load), and sent with
// keepalive when they fit its 64 KiB limit.
window.addEventListener('pagehide', () => {
  if (!sb.project || !sbUnsaved()) return;
  clearTimeout(sb.saveTimer);
  sbKeepDraft();
  const body = JSON.stringify({ strokes: sb.strokes });
  if (body.length < 60_000) fetch(sbPath('/canvas'), { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
});

'use strict';
// views (#/keskus, #/taulu, …) and the command centre.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- views: #/keskus (command centre, default) and #/taulu (the board) ----
const VIEWS = { keskus: 'Komentokeskus', taulu: 'Taulu', riippuvuudet: 'Riippuvuudet', muutokset: 'Muutokset', asetukset: 'Asetukset' };
function setView() {
  const wanted = location.hash.replace(/^#\//, '');
  const view = wanted in VIEWS ? wanted : 'keskus';
  document.body.dataset.view = view;
  document.getElementById('view-title').textContent = VIEWS[view];
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', () => { setView(); if (meta) renderGraph(); });
setView();

// ---- command centre: every card that has an agent or waits for one, most urgent first, plus the chosen agent's panel ----
const AGENT_ORDER = ['needs_input', 'review', 'running', 'refining', 'ready'];
const HAS_RUN = ['running', 'needs_input', 'review']; // cards whose run and diff are worth reading
let selectedAgent = null;
let agentInfo = new Map(); // card id -> { run, question, commitMessage, stats }
let agentInfoJson = '', journalEvents = [];

/** The unified patches of /api/cards/:id/diff as files with +/- counts and numbered lines (old/new line numbers from the hunk headers). */
function parseDiff(d) {
  const files = [];
  const many = d.repos.filter((r) => r.patch).length > 1;
  let truncated = false;
  for (const r of d.repos) {
    if (!r.patch) continue;
    truncated ||= r.truncated;
    let cur = null, inHunk = false, o = 0, n = 0;
    for (const line of r.patch.split('\n')) {
      if (line.startsWith('diff --git ')) {
        cur = { path: (many ? `${r.repo}/` : '') + (line.split(' b/')[1] ?? '?'), add: 0, del: 0, lines: [] };
        files.push(cur); inHunk = false;
      } else if (!cur) continue;
      else if (line.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
        o = m ? Number(m[1]) : 0; n = m ? Number(m[2]) : 0; inHunk = true;
        cur.lines.push({ cls: 'hunk', text: line });
      } else if (!inHunk || line.startsWith('\\')) cur.lines.push({ cls: 'meta', text: line });
      else if (line.startsWith('+')) { cur.add++; cur.lines.push({ cls: 'add', n: n++, text: line }); }
      else if (line.startsWith('-')) { cur.del++; cur.lines.push({ cls: 'del', o: o++, text: line }); }
      else cur.lines.push({ cls: '', o: o++, n: n++, text: line });
    }
  }
  return { files, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0), truncated };
}
const diffStats = (d) => { const p = parseDiff(d); return { ...p, files: p.files.map(({ path, add, del }) => ({ path, add, del })) }; };

function elapsed(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return Number.isNaN(min) ? '–' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

async function loadAgentInfo() {
  if (document.hidden || !['keskus', 'muutokset'].includes(document.body.dataset.view)) return;
  const ids = cards.filter((c) => HAS_RUN.includes(c.status)).map((c) => c.id);
  try {
    const [events, ...infos] = await Promise.all([api('/api/events?limit=300'), ...ids.map(async (id) => {
      try {
        const [d, diff] = await Promise.all([api(`/api/cards/${id}/run`), api(`/api/cards/${id}/diff`)]);
        return [id, { run: d.run, question: d.question, commitMessage: d.commitMessage, report: d.report, prs: d.prs ?? [], localMerge: d.localMerge, stats: diffStats(diff) }];
      } catch { return null; } // a card that changed under us: show it without details
    })]);
    const json = JSON.stringify([events.slice(-60), infos]);
    if (json === agentInfoJson) return;
    agentInfoJson = json;
    agentInfo = new Map(infos.filter(Boolean));
    journalEvents = events;
    renderAgents();
    renderChanges();
    renderEvents();
  } catch { /* the next tick tries again */ }
}

/** One line on what the agent is doing / waiting for. */
function agentActivity(c, info) {
  const run = info?.run;
  const ph = phaseInfo.cards[c.id];
  if (!run) return ph?.reason ?? '';
  if (run.waitingFor) return `lupakysely: ${run.waitingFor}`;
  if (info.question) return 'kysymys odottaa vastaustasi';
  if (run.error) return `virhe: ${run.error.split('\n')[0].slice(0, 80)}`;
  if (run.review?.state === 'failed') return 'katselmointi epäonnistui';
  if (ph?.quiet) return ph.reason;
  if (run.review?.state === 'done') return `katselmointi valmis, ${run.review.findings.length} löydöstä`;
  return RUN_LABEL[run.state] ?? run.state;
}

function agentPanel(c) {
  const info = agentInfo.get(c.id);
  const run = info?.run;
  const btn = (text, className, onClick) => { const b = el('button', { type: 'button', className, textContent: text }); b.addEventListener('click', onClick); return b; };
  const section = (title, ...kids) => el('div', { className: 'sec' }, el('h3', { textContent: title }), ...kids);
  const out = [el('div', { className: `phead s-${c.status} ${toneClass(c)}` },
    el('span', { className: 'chip' }, svgIcon(STATUS_ICON[c.status], 13, 2.4), phaseLabel(c)),
    el('span', { className: 'mono muted', textContent: run?.agentId ?? c.id }),
    el('h2', { textContent: c.title }))];

  const facts = [['Repo', c.repos.join(', ') || '–']];
  const wt = run?.worktrees?.[0];
  if (wt) facts.push(['Haara', `${wt.branch} ← ${wt.base}`], ['Työkansio', wt.path]);
  const model = [run?.model ?? c.model, run?.effort ?? c.effort].filter(Boolean).join(' / ');
  if (model) facts.push(['Malli', model]);
  if (run?.startedAt) facts.push(['Aloitettu', `${stamp(run.startedAt)} (${elapsed(run.startedAt)} sitten)`]);
  out.push(el('dl', { className: 'facts' }, ...facts.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })])));

  if (info?.question) out.push(el('div', { className: 'alert warn' }, el('b', { textContent: 'Agentin kysymys' }), el('div', { className: 'pre', textContent: info.question.slice(0, 600) })));
  if (run?.waitingFor) out.push(el('div', { className: 'alert err' }, el('b', { textContent: 'Odottaa lupaa' }), el('div', { className: 'mono', textContent: run.waitingFor })));
  if (run?.error) out.push(el('div', { className: 'alert err' }, el('b', { textContent: 'Virhe' }), el('div', { className: 'pre', textContent: run.error })));

  const st = info?.stats;
  if (st) {
    out.push(section(`Muutokset${st.files.length ? ` · +${st.add} −${st.del}` : ''}`,
      ...(st.files.length ? st.files.map((f) => el('div', { className: 'file' }, el('span', { className: 'mono', textContent: f.path }),
        el('span', { className: 'mono' }, el('span', { className: 'plus', textContent: `+${f.add}` }), ' ', el('span', { className: 'minus', textContent: `−${f.del}` })))) : [el('div', { className: 'muted', textContent: 'Ei muutoksia haarassa vielä.' })]),
      ...(st.truncated ? [el('div', { className: 'muted', textContent: 'Diff oli pitkä, luvut ovat arvioita.' })] : []),
      ...(info.commitMessage ? [el('div', { className: 'muted', textContent: `Commit-viesti: ${info.commitMessage.split('\n')[0]}` })] : [])));
  }
  const rv = run?.review;
  if (rv) {
    out.push(section('Katselmointi', el('div', { className: rv.state === 'failed' ? 'err' : '', textContent: rv.state === 'failed' ? `Epäonnistui: ${rv.error}` : `${rv.findings.length} löydöstä` }),
      ...(rv.findings ?? []).slice(0, 4).map((f) => el('div', { className: 'muted', textContent: `[${f.severity ?? '–'}] ${f.file}${f.line ? ':' + f.line : ''}: ${f.summary}` }))));
  }
  const events = journalEvents.filter((e) => e.card === c.id).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 6);
  if (events.length) out.push(section('Viimeisimmät tapahtumat', ...events.map((e) => el('div', { className: `ev${e.level === 'error' ? ' err' : ''}` }, el('span', { className: 'mono muted', textContent: stamp(e.t).split(' ')[1] }), el('span', { textContent: e.text })))));

  const actions = [];
  if (run?.waitingFor) actions.push(btn('Avaa lupakysely', 'primary', () => openPermissionPrompt(c.id)));
  else if (c.status === 'needs_input') actions.push(btn('Vastaa', 'primary', () => openDetail(c.id)));
  else if (c.status === 'review') actions.push(btn('Katsele ja hyväksy', 'primary', () => openDetail(c.id)));
  if (c.status === 'running' || c.status === 'needs_input') {
    actions.push(btn('Pysäytä', 'danger', async () => {
      if (!(await confirmBox({ title: 'Pysäytä agentti', text: 'Pysäytetäänkö agentti? Sen kesken oleva työ jää työkansioon.', ok: 'Pysäytä', danger: true }))) return;
      try { await api(`/api/cards/${c.id}/run/stop`, { method: 'POST', body: {} }); } catch (e) { toast(e.message); }
      await refresh(true); loadNext(); agentInfoJson = ''; loadAgentInfo();
    }));
  }
  if (run && (run.state === 'failed' || run.state === 'stopped')) {
    actions.push(btn('Yritä uudelleen / jatka', 'primary', async () => {
      try { await api(`/api/cards/${c.id}/run/retry`, { method: 'POST', body: {} }); } catch (e) { toast(e.message); }
      await refresh(true); loadNext(); agentInfoJson = ''; loadAgentInfo();
    }));
  }
  actions.push(btn(c.status === 'review' ? 'Avaa kortti ja diff' : 'Avaa kortti', '', () => openDetail(c.id)));
  out.push(el('div', { className: 'row pactions' }, ...actions));
  return out;
}

function renderAgents() {
  const live = cards.filter((c) => AGENT_ORDER.includes(c.status))
    .sort((a, b) => AGENT_ORDER.indexOf(a.status) - AGENT_ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt));
  if (!live.some((c) => c.id === selectedAgent)) selectedAgent = live[0]?.id ?? null;
  const rows = live.map((c) => {
    const info = agentInfo.get(c.id);
    const st = info?.stats;
    const run = info?.run;
    const row = el('button', { type: 'button', className: `agent s-${c.status} ${toneClass(c)}`, ariaPressed: String(c.id === selectedAgent) },
      el('span', { className: 'top' }, el('span', { className: 'chip' }, svgIcon(STATUS_ICON[c.status], 13, 2.4), phaseLabel(c)), el('span', { className: 'title', textContent: c.title })),
      el('span', { className: 'when' }, ...(st ? [el('span', { className: 'plus', textContent: `+${st.add}` }), ' ', el('span', { className: 'minus', textContent: `−${st.del}` }), ` · ${st.files.length} tdst`] : [stamp(c.updatedAt)])),
      el('span', { className: 'sub', textContent: [c.repos.join(', '), agentActivity(c, info)].filter(Boolean).join(' · ') || c.id }),
      el('span', { className: 'when', textContent: run?.startedAt && c.status !== 'review' ? elapsed(run.startedAt) : '' }));
    row.addEventListener('click', () => { selectedAgent = c.id; renderAgents(); });
    return row;
  });
  const chosen = live.find((c) => c.id === selectedAgent);
  document.getElementById('agents').replaceChildren(
    el('div', { className: 'list' },
      el('div', { className: 'head' }, el('h2', { textContent: 'Agentit' }), el('span', { className: 'muted', textContent: `${live.length} korttia liikkeellä` })),
      ...(rows.length ? rows : [el('div', { className: 'empty', textContent: 'Ei agentteja liikkeellä. Luo kortti tai pyydä ohjaajaa tekemään se.' })])),
    ...(chosen ? [el('div', { className: 'panel' }, ...agentPanel(chosen))] : []));
}

/** The newest journal entries, for the command centre's "Tapahtumat" card (the full log stays in the side pane). */
const EVENT_TONE = { agent: 'var(--blue)', review: 'var(--violet)', refine: 'var(--blue)', pr: 'var(--green)', card: 'var(--muted)' };
function renderEvents() {
  const newest = [...journalEvents].sort((a, b) => b.t.localeCompare(a.t)).slice(0, 8);
  document.getElementById('events').replaceChildren(
    el('div', { className: 'head' }, el('h2', { textContent: 'Tapahtumat' }), el('span', { className: 'muted', textContent: 'Uusin ylhäällä' })),
    ...(newest.length ? newest.map((e) => el('div', { className: 'ev' },
      el('span', { className: 'mono muted', textContent: stamp(e.t).split(' ')[1] }),
      el('span', { className: 'dot', style: `background:${e.level === 'error' ? 'var(--high)' : EVENT_TONE[e.kind] ?? 'var(--muted)'}` }),
      el('span', { textContent: e.text }))) : [el('div', { className: 'empty', textContent: 'Ei tapahtumia vielä.' })]));
}

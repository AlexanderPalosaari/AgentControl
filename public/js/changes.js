'use strict';
// the diff of one card, its review result and the approval.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

// ---- changes: the diff of one card at a time, its review result and the approval ----
const CHANGE_ORDER = ['review', 'needs_input', 'running'];
let selectedChange = null, selectedFile = null, changeDiff = null, changeJson = '';

async function loadChange() {
  if (document.hidden || document.body.dataset.view !== 'muutokset' || !selectedChange) return;
  const id = selectedChange;
  try {
    const d = await api(`/api/cards/${id}/diff`);
    const json = JSON.stringify(d);
    if (id !== selectedChange || (changeDiff?.id === id && json === changeJson)) return;
    changeJson = json;
    changeDiff = { id, ...parseDiff(d), repos: d.repos };
    renderChanges();
  } catch { /* the next tick tries again */ }
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 3 };
const sortedFindings = (rv) => [...(rv.findings ?? [])].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2));

function renderChanges() {
  const box = document.getElementById('changes');
  const list = cards.filter((c) => CHANGE_ORDER.includes(c.status))
    .sort((a, b) => CHANGE_ORDER.indexOf(a.status) - CHANGE_ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt));
  const waiting = list.filter((c) => c.status === 'review').length;
  const badge = document.getElementById('nav-changes');
  badge.hidden = !waiting;
  badge.textContent = waiting;
  if (document.body.dataset.view !== 'muutokset') return;
  if (!list.some((c) => c.id === selectedChange)) { selectedChange = list[0]?.id ?? null; selectedFile = null; changeDiff = null; loadChange(); }
  if (!selectedChange) return box.replaceChildren(el('div', { className: 'empty', textContent: 'Ei muutoksia luettavana. Kun agentti on valmis, sen muutokset ilmestyvät tänne.' }));
  const c = list.find((x) => x.id === selectedChange);
  const info = agentInfo.get(c.id), run = info?.run, rv = run?.review;
  const d = changeDiff?.id === c.id ? changeDiff : null;
  if (selectedFile && !d?.files.some((f) => f.path === selectedFile)) selectedFile = null;
  const btn = (text, className, onClick) => { const b = el('button', { type: 'button', className, textContent: text }); b.addEventListener('click', onClick); return b; };
  const finish = async (done, message) => {
    if (done === null) return;
    if (done) reply(`${message}: ${c.title}`);
    await refresh(true); loadNext(); agentInfoJson = ''; loadAgentInfo();
  };

  const side = el('div', { className: 'clist' }, el('h2', { textContent: 'Haarat' }),
    ...list.map((x) => {
      const st = agentInfo.get(x.id)?.stats;
      const b = el('button', { type: 'button', className: `change s-${x.status}`, ariaPressed: String(x.id === c.id) },
        el('span', { className: 'title', textContent: x.title }),
        el('span', { className: 'mono' }, ...(st ? [el('span', { className: 'plus', textContent: `+${st.add}` }), ' ', el('span', { className: 'minus', textContent: `−${st.del}` }), ' · '] : []), x.repos.join(', ') || LABELS[x.status]),
        el('span', { className: 'chip', textContent: LABELS[x.status] }));
      b.addEventListener('click', () => { selectedChange = x.id; selectedFile = null; changeDiff = null; renderChanges(); loadChange(); });
      return b;
    }));

  const wt = run?.worktrees?.[0];
  const actions = [];
  if (c.status === 'review' && info?.localMerge && run) actions.push(btn('Hyväksy työ projektiin', 'primary', async (ev) => finish(await mergeLocal(c, run, info.commitMessage, ev.currentTarget), 'Työ yhdistetty projektiin')));
  else if (c.status === 'review' && run?.worktrees?.length && (info.prs?.length ?? 0) < run.worktrees.length) actions.push(btn('Luo pull request Azure DevOpsiin', 'primary', async (ev) => finish(await openPullRequest(c, run, ev.currentTarget), 'Pull request luotu')));
  actions.push(btn('Avaa kortti', '', () => openDetail(c.id)));
  const head = el('div', { className: `chead s-${c.status}` },
    el('div', {}, el('span', { className: 'chip', textContent: LABELS[c.status] }), el('h2', { textContent: c.title }),
      el('div', { className: 'mono muted', textContent: wt ? `${wt.repo} · ${wt.branch} ← ${wt.base}` : c.repos.join(', ') })),
    el('div', { className: 'row' }, ...actions));

  const tile = (label, value, note = '') => el('div', { className: 'tile' }, el('span', { textContent: label }), el('b', { textContent: value }), ...(note ? [el('span', { className: 'muted', textContent: note })] : []));
  const reviewValue = !rv ? 'ei ajettu' : rv.state === 'failed' ? 'epäonnistui' : `${rv.findings.length} löydöstä`;
  const tiles = el('div', { className: 'tiles' },
    tile('Rivejä', d ? `+${d.add} −${d.del}` : '…'), tile('Tiedostoja', d ? String(d.files.length) : '…'),
    tile('Katselmointi', reviewValue, rv?.state === 'done' && rv.findings.length ? `${rv.findings.filter((f) => f.severity !== 'low').length} vakavaa, loput pieniä` : ''),
    tile('Pull requestit', String(info?.prs?.length ?? 0), info?.prs?.length ? info.prs.map((p) => `${p.repo} #${p.id}`).join(', ') : ''));

  const parts = [head, tiles];
  if (rv) {
    parts.push(el('div', { className: `alert ${rv.state === 'failed' || rv.findings.length ? 'warn' : 'ok'}` },
      el('b', { textContent: 'Automaattinen katselmointi' }),
      el('div', { className: 'pre', textContent: rv.state === 'failed' ? `Epäonnistui: ${rv.error}` : (rv.summary || (rv.findings.length ? '' : 'Ei löydöksiä.')) }),
      ...sortedFindings(rv).map((f) => el('div', { className: 'pre', textContent: `[${f.severity ?? '–'}${f.severity === 'low' ? ' · ei korjauspyyntöä agentille' : ''}] ${f.file}${f.line ? ':' + f.line : ''}: ${f.summary}\n${f.failure_scenario}` }))));
  }
  if (info?.commitMessage) parts.push(el('div', { className: 'alert' }, el('b', { textContent: 'Ehdotettu commit-viesti' }), el('div', { className: 'pre', textContent: info.commitMessage })));
  if (info?.report) parts.push(el('details', { className: 'alert' }, el('summary', { textContent: 'Agentin raportti' }), el('div', { className: 'pre', textContent: info.report })));

  if (!d) parts.push(el('div', { className: 'muted', textContent: 'Haetaan muutoksia…' }));
  else if (!d.files.length) parts.push(el('div', { className: 'muted', textContent: d.repos.some((r) => r.gone) ? 'Työkansio on siivottu pois (kortti on valmis).' : 'Ei muutoksia haarassa vielä.' }));
  else {
    const files = el('div', { className: 'cfiles' },
      ...[null, ...d.files.map((f) => f.path)].map((path) => {
        const f = d.files.find((x) => x.path === path);
        const b = el('button', { type: 'button', ariaPressed: String(path === selectedFile) },
          el('span', { className: 'mono', textContent: path ?? `Kaikki (${d.files.length})` }),
          ...(f ? [el('span', { className: 'mono' }, el('span', { className: 'plus', textContent: `+${f.add}` }), ' ', el('span', { className: 'minus', textContent: `−${f.del}` }))] : []));
        b.addEventListener('click', () => { selectedFile = path; renderChanges(); });
        return b;
      }));
    const shown = selectedFile ? d.files.filter((f) => f.path === selectedFile) : d.files;
    const diff = el('div', { className: 'cdiff' }, el('div', { className: 'inner' }, ...shown.flatMap((f) => [
      el('div', { className: 'dfile', textContent: f.path }),
      ...f.lines.map((l) => el('div', { className: `dl ${l.cls}` }, el('span', { className: 'no', textContent: l.o ?? '' }), el('span', { className: 'no', textContent: l.n ?? '' }), el('span', { textContent: l.text || ' ' }))),
    ])));
    parts.push(el('div', { className: 'cview' }, files, diff));
    if (d.truncated) parts.push(el('div', { className: 'muted', textContent: 'Diff on lyhennetty. Katso loput terminaalista.' }));
  }
  box.replaceChildren(side, el('div', { className: 'cmain' }, ...parts));
}

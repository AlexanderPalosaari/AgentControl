'use strict';
// start-up.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

(async () => {
  meta = await api('/api/meta');
  await refresh(true);
  loadDispatcher();
  loadProjects();
  loadNext();
  restoreChat();
  try { if (localStorage.getItem('ac_log') === '1') setLogOpen(true); } catch { /* storage unavailable: closed */ }
  loadAgentInfo();
  loadChange();
  loadSettings();
  loadUsage(true);
  setInterval(() => { refresh(); loadDispatcher(); loadProjects(); loadNext(); loadAgentInfo(); loadChange(); loadSettings(); loadUsage(); }, 3000);
  window.addEventListener('hashchange', () => { renderChanges(); loadAgentInfo(); loadChange(); loadSettings(); loadUsage(true); });
})().catch((e) => toast(e.message));

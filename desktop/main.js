// Desktop shell: runs server.js as a child process, shows the UI in a window and keeps a tray icon
// that reports how many cards wait for the person. Closing the window hides it; Quit stops the server, after asking
// when work is running.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, session, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quitWarning } from '../lib/activity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let server, win, tray, url, quitting = false;
let quitAgreed = false; // the person said to quit although work runs, or the system is shutting down
let asking = false;     // the "quit anyway?" question is on screen
let toldHidden = false; // the "still running in the tray" note was shown (once per run)
let notified = null; // keys of the "your turn" items already seen; null until the first look, which only seeds it

/** A solid 32x32 PNG, so the tray needs no image asset. */
function iconPng(r, g, b) {
  const size = 32;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 15 ** 2;
      raw.set(inside ? [r, g, b, 255] : [0, 0, 0, 0], i);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const ICON_IDLE = nativeImage.createFromBuffer(iconPng(90, 130, 220));
const ICON_WAITING = nativeImage.createFromBuffer(iconPng(235, 150, 40));

const readToken = () => readFileSync(join(process.env.AGENTCONTROL_DATA ?? join(root, 'data'), 'token.txt'), 'utf8').trim();

/** The address of a server started elsewhere (same data folder, same port), built from the saved token. */
function runningUrl() {
  const token = readToken();
  return `http://127.0.0.1:${process.env.PORT ?? 4310}/?token=${token}`;
}

/** Starts server.js with Electron's own Node and resolves with the URL it prints (token included). */
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [join(root, 'server.js')], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?(?:token|login)=\S+/);
      if (m) resolve(m[0]);
    });
    server.stderr.on('data', (d) => { out += d; });
    server.on('exit', (code) => {
      if (quitting) return;
      if (!url && code === 75) return resolve(runningUrl()); // already served by another instance: just open it
      if (!url) return reject(new Error(`server exited (${code}): ${out.trim().slice(-400)}`));
      // It was running and died: start it again (same data folder and token, so the open window keeps working).
      // Exit 75 = another instance (e.g. the scheduled watchdog) already serves this data: use it instead.
      if (code === 75) return;
      setTimeout(() => { if (!quitting) startServer().catch((e) => console.error(e.message)); }, 3000);
    });
  });
}

function showWindow() {
  if (!win) {
    win = new BrowserWindow({ width: 1400, height: 900, title: 'AgentControl', autoHideMenuBar: true, webPreferences: { preload: join(root, 'desktop', 'preload.cjs') } });
    win.loadURL(url);
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      win.hide();
      tellStillRunning();
    });
    win.on('session-end', () => { quitAgreed = true; }); // Windows is logging off or shutting down: never hold it up
  }
  win.show();
  win.focus();
}

/** The token for our own API calls: the page's cookie, else the saved one. */
async function authToken() {
  const cookies = await win?.webContents.session.cookies.get({ name: 'ac_token' });
  return cookies?.[0]?.value ?? readToken();
}

/** What stopping the server would cut off (GET /api/activity); null when the server does not answer. */
async function activity() {
  try {
    const res = await fetch(new URL('/api/activity', url), { headers: { Cookie: `ac_token=${await authToken()}` }, signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The first time the window is closed (hidden) while work runs: a note that it goes on, and where to quit. */
async function tellStillRunning() {
  if (toldHidden || !Notification.isSupported()) return;
  const now = await activity();
  if (!now?.items.length || toldHidden) return;
  toldHidden = true;
  const n = new Notification({ title: 'AgentControl jatkaa taustalla', body: `${now.items.length === 1 ? '1 työ' : `${now.items.length} työtä`} käynnissä. Ikkuna vain piilotettiin; lopeta ilmaisinalueen kuvakkeen valikosta.` });
  n.on('click', showWindow);
  n.show();
}

/**
 * Whether to go on quitting: true when nothing would be cut off, or when the person says to quit anyway after seeing
 * what runs. Only this app's own server stops on quit; one served by another instance (exit 75) keeps its work.
 */
async function confirmQuit() {
  if (!server || server.exitCode !== null || !url) return true;
  const warning = quitWarning((await activity()) ?? {});
  if (!warning) return true; // nothing runs, or the server does not answer: there is nothing to wait for
  const options = {
    type: 'warning', title: 'AgentControl', message: warning.message, detail: warning.detail,
    buttons: ['Älä lopeta', 'Lopeta silti'], defaultId: 0, cancelId: 0, noLink: true,
  };
  const { response } = win?.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 1;
}

/**
 * Asks the server what waits for the person (the same list as the board's "Sinun vuorosi"), colours the tray icon and
 * shows one notification for each item that is new since the last look: what happened and on which card, not a count.
 * The cookie from the first page load authenticates the request.
 */
async function pollWaiting() {
  try {
    const res = await fetch(new URL('/api/next', url), { headers: { Cookie: `ac_token=${await authToken()}` } });
    if (!res.ok) return;
    // The inbox line is a suggestion, not something that is stuck on the person.
    const items = (await res.json()).yourTurn.filter((i) => i.what !== 'Inbox');
    tray.setImage(items.length ? ICON_WAITING : ICON_IDLE);
    tray.setToolTip(items.length ? `AgentControl: ${items.length} odottaa sinua` : 'AgentControl');
    const keyOf = (i) => `${i.card ?? i.project}|${i.what}`;
    const seen = notified;
    notified = new Set(items.map(keyOf));
    if (!seen || !Notification.isSupported()) return;
    for (const item of items.filter((i) => !seen.has(keyOf(i))).slice(0, 3)) {
      const n = new Notification({ title: `AgentControl: ${item.what}`, body: item.detail ? `${item.title}\n${item.detail}` : item.title });
      n.on('click', showWindow);
      n.show();
    }
  } catch { /* the server may be starting or stopping */ }
}

/** The folder picker for "Lisää olemassa oleva": answers only our own page; null when cancelled. */
ipcMain.handle('pick-folder', async (event) => {
  if (!event.senderFrame?.url.startsWith(new URL(url).origin)) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Valitse projektin kansio', properties: ['openDirectory'] });
  return canceled ? null : filePaths[0];
});

const ARTIFACT_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+(?:\?[\w=&%-]*)?$/;
const MAX_ARTIFACT = 300_000;

/**
 * The text of a claude.ai artifact, for the sandbox: an artifact opens only with the person's own claude.ai login, so
 * it is loaded in a window of its own with a session of its own (persist:claude-ai, kept apart from our page). The
 * window stays hidden while the artifact loads; when claude.ai asks to sign in, it is shown and the person signs in
 * there themself, once. The content renders in a frame on *.claudeusercontent.com, whose text is read.
 */
function fetchArtifact(link) {
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({ width: 1000, height: 800, show: false, title: 'Kirjaudu claude.ai:hin, niin AgentControl voi lukea artifaktin', autoHideMenuBar: true, parent: win, webPreferences: { partition: 'persist:claude-ai' } });
    let done = false, timer = null, deadline = Date.now() + 30_000;
    const finish = (err, out) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      if (err) reject(err); else resolve(out);
    };
    w.on('closed', () => finish(new Error('Artifaktin ikkuna suljettiin ennen kuin sisältö latautui.')));
    // After signing in claude.ai lands on its front page: go back to the artifact.
    w.webContents.on('did-navigate', (_e, at) => {
      if (/^https:\/\/claude\.ai\/(new|recents|chats?)?\/?$/.test(at.split('?')[0])) w.loadURL(link);
    });
    timer = setInterval(async () => {
      if (done || w.isDestroyed()) return;
      try {
        const main = w.webContents.mainFrame;
        if (/\/login|\/sign-?in|\/magic-link/.test(main.url) || /Sign in to view/i.test(await main.executeJavaScript('document.body?.innerText ?? ""'))) {
          if (!w.isVisible()) { w.show(); w.focus(); }
          deadline = Math.max(deadline, Date.now() + 5 * 60_000); // time for the person to sign in
          return;
        }
        let best = null;
        for (const f of main.framesInSubtree) {
          if (!/\.claudeusercontent\.com$/.test(new URL(f.url || 'about:blank').hostname || '')) continue;
          const text = String(await f.executeJavaScript('document.body?.innerText ?? ""')).trim();
          if (text && (!best || text.length > best.text.length)) best = { text, title: String(await f.executeJavaScript('document.title')).trim() };
        }
        if (best) {
          const title = best.title || String(await main.executeJavaScript('document.title')).replace(/\s*[-–|]\s*Claude.*$/, '').trim();
          return finish(null, { title: title === 'Claude Artifact' ? '' : title, content: best.text.slice(0, MAX_ARTIFACT) });
        }
      } catch { /* a frame that is still loading or navigating: try again on the next tick */ }
      if (Date.now() > deadline) finish(new Error('Artifaktin sisältö ei latautunut.'));
    }, 1000);
    w.loadURL(link).catch((e) => finish(new Error(`Artifaktia ei saatu auki: ${e.message}`)));
  });
}

ipcMain.handle('fetch-artifact', async (event, link) => {
  if (!event.senderFrame?.url.startsWith(new URL(url).origin)) throw new Error('not allowed');
  if (typeof link !== 'string' || !ARTIFACT_RE.test(link)) throw new Error('Ei claude.ai-artifaktin linkki.');
  return fetchArtifact(link);
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => url && showWindow());

app.whenReady().then(async () => {
  try {
    url = await startServer();
  } catch (e) {
    console.error(e.message);
    return app.quit();
  }
  // The page records the microphone for local speech recognition: allow that for our own server only.
  const ours = (wc) => wc?.getURL().startsWith(new URL(url).origin);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'media' && ours(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && ours(wc));
  tray = new Tray(ICON_IDLE);
  tray.setToolTip('AgentControl');
  tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Avaa', click: showWindow },
    { label: 'Lopeta', click: () => app.quit() },
  ]));
  powerMonitor.on('shutdown', () => { quitAgreed = true; }); // macOS and Linux; Windows tells the window (session-end)
  showWindow();
  setInterval(pollWaiting, 15_000);
  pollWaiting();
});

app.on('window-all-closed', () => { /* stay in the tray */ });
// Quit (tray, menu) first asks when work is running; the question cancels this quit and quits again on "Lopeta silti".
app.on('before-quit', (e) => {
  if (quitting) return;
  if (!quitAgreed) {
    e.preventDefault();
    if (asking) return;
    asking = true;
    confirmQuit()
      .catch(() => true)
      .then((go) => { asking = false; if (go) { quitAgreed = true; app.quit(); } });
    return;
  }
  quitting = true;
  server?.kill();
});

// Desktop shell: runs server.js as a child process, shows the UI in a window and keeps a tray icon
// that reports how many cards wait for the person. Closing the window hides it; Quit stops the server.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let server, win, tray, url, quitting = false;
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
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  }
  win.show();
  win.focus();
}

/**
 * Asks the server what waits for the person (the same list as the board's "Sinun vuorosi"), colours the tray icon and
 * shows one notification for each item that is new since the last look: what happened and on which card, not a count.
 * The cookie from the first page load authenticates the request.
 */
async function pollWaiting() {
  try {
    const cookies = await win?.webContents.session.cookies.get({ name: 'ac_token' });
    const token = cookies?.[0]?.value ?? readToken();
    const res = await fetch(new URL('/api/next', url), { headers: { Cookie: `ac_token=${token}` } });
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
  showWindow();
  setInterval(pollWaiting, 15_000);
  pollWaiting();
});

app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; server?.kill(); });

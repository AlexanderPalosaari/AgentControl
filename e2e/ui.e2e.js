// Real-browser smoke test: boots the server with the fake claude and drives the UI through Chrome.
// Needs a local Chrome/Edge (CHROME_PATH overrides the lookup). Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';

const fake = fileURLToPath(new URL('../test/fake-claude.js', import.meta.url));
const fakeSandbox = fileURLToPath(new URL('../test/fake-sandbox-claude.js', import.meta.url));
const token = 't';
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => p && existsSync(p));

let dir, server, base, browser, page;
const errors = [];

before(async () => {
  assert.ok(CHROME, 'No Chrome found; set CHROME_PATH');
  dir = await mkdtemp(join(tmpdir(), 'agentcontrol-e2e-'));
  await mkdir(join(dir, 'repos', 'repo-a'), { recursive: true });
  server = createApp({ dataDir: join(dir, 'data'), token, reposRoot: join(dir, 'repos'), claude: createClaude({ command: process.execPath, prefixArgs: [fake] }), sandbox: { claude: createClaude({ command: process.execPath, prefixArgs: [fakeSandbox] }) } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => r.status() >= 400 && !r.url().endsWith('/favicon.ico') && errors.push(`${r.status()} ${r.url()}`));
});
after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('token link logs in and the board loads without console errors', async () => {
  await page.goto(`${base}/?token=${token}`, { waitUntil: 'networkidle0' });
  assert.equal(new URL(page.url()).pathname, '/');
  await page.waitForSelector('#board');
  assert.deepEqual(errors, []);
});

test('creating a card through the dialog shows it on the board', async () => {
  await page.click('#new');
  await page.waitForSelector('#dlg[open]');
  await page.type('#f-title', 'E2E kortti');
  await page.type('#f-brief', 'tee jotain');
  await page.type('#f-repos', 'repo-a');
  await page.click('#form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#dlg[open]'));
  await page.waitForFunction(() => [...document.querySelectorAll('.card .title')].some((t) => t.textContent === 'E2E kortti'));
  assert.deepEqual(errors, []);
});

test('clicking the card title opens the detail dialog', async () => {
  await page.evaluate(() => [...document.querySelectorAll('.card .title')].find((t) => t.textContent === 'E2E kortti').click());
  await page.waitForSelector('#detail[open]');
  assert.equal(await page.$eval('#d-title', (e) => e.textContent), 'E2E kortti');
  assert.match(await page.$eval('#d-brief', (e) => e.textContent), /tee jotain/);
});

test('the command field runs commands and follows into the open dialog', async () => {
  const send = async (text) => {
    await page.focus('#cmd-input');
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await send('lisää kortti');
  await page.waitForSelector('#dlg[open] #cmd', { timeout: 5000 });
  await send('sulje');
  await page.waitForFunction(() => !document.querySelector('#dlg[open]') && document.querySelector('#chat-dock > #cmd'));
  await send('/arkistoi e2e kortti');
  await page.waitForFunction(() => [...document.querySelectorAll('#cmd-log .bot')].some((b) => b.textContent.includes('→ Archive')));
  await send('perusta projekti');
  await page.waitForFunction(() => document.querySelector('#cmd-log .bot:last-child')?.textContent.includes('nimeksi'));
  await send('peruuta');
  await page.waitForFunction(() => document.querySelector('#cmd-log .bot:last-child')?.textContent.includes('ohitetaan'));
  assert.equal(await page.$eval('#cmd-ask', (e) => e.textContent), '');
  assert.deepEqual(errors, []);
});

test('"Aloita tarkennus" closes the card dialog and the card moves to Refining on the board', async () => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => fetch('/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E tarkennus', repos: ['repo-a'] }) }));
  await page.waitForFunction(() => [...document.querySelectorAll('.card .title')].some((t) => t.textContent === 'E2E tarkennus'), { timeout: 8000 });
  await page.evaluate(() => [...document.querySelectorAll('.card .title')].find((t) => t.textContent === 'E2E tarkennus').click());
  await page.waitForSelector('#detail[open]');
  await page.waitForFunction(() => [...document.querySelectorAll('#detail button')].some((b) => b.textContent === 'Aloita tarkennus'));
  await page.evaluate(() => [...document.querySelectorAll('#detail button')].find((b) => b.textContent === 'Aloita tarkennus').click());
  await page.waitForFunction(() => !document.querySelector('#detail[open]'), { timeout: 5000 });
  await page.waitForFunction(() => {
    const col = [...document.querySelectorAll('.col')].find((c) => c.querySelector('h2')?.textContent.includes('Refining'));
    return [...(col?.querySelectorAll('.card .title') ?? [])].some((t) => t.textContent === 'E2E tarkennus');
  }, { timeout: 5000 });
  assert.ok(await page.$$eval('#cmd-log .bot', (els) => els.some((e) => e.textContent.startsWith('Tarkennus aloitettu: E2E tarkennus'))), 'what happened is told in the command log');
  assert.deepEqual(errors, []);
});

test('a project\'s model and effort are chosen in the new-project form and changed in the project dialog', async () => {
  const MODEL = '#pdlg input[list=p-models]';
  const EFFORT = '#pdlg .pair select';
  const project = () => page.evaluate(async () => (await fetch('/api/projects/e2e-proj')).json());
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await page.click('#new-project');
  await page.waitForSelector('#pdlg[open] #p-name');
  await page.type('#p-name', 'e2e-proj');
  await page.type(MODEL, 'opus');
  await page.select(EFFORT, 'high');
  await page.evaluate(() => [...document.querySelectorAll('#pdlg button')].find((b) => b.textContent === 'Luo projekti').click());
  await page.waitForFunction(() => document.getElementById('p-title').textContent === 'e2e-proj');
  assert.deepEqual([(await project()).model, (await project()).effort], ['opus', 'high']);
  assert.equal(await page.$eval(MODEL, (e) => e.value), 'opus', 'the dialog shows what was chosen');
  assert.equal(await page.$eval(EFFORT, (e) => e.value), 'high');

  await page.$eval(MODEL, (e) => { e.value = ''; });
  await page.type(MODEL, 'sonnet');
  await page.select(EFFORT, '');
  await page.evaluate(() => [...document.querySelectorAll('#pdlg button')].find((b) => b.textContent === 'Tallenna').click());
  await page.waitForFunction(async () => (await (await fetch('/api/projects/e2e-proj')).json()).model === 'sonnet');
  assert.deepEqual([(await project()).model, (await project()).effort], ['sonnet', null]);
  await page.waitForFunction(() => [...document.querySelectorAll('#projects .proj')].some((s) => s.title.includes('sonnet') && !s.title.includes('high')));
  assert.deepEqual(errors, []);
});

test('the command centre lists agents with a panel for the chosen one, and the nav switches to the board', async () => {
  await page.goto(`${base}/?view=centre#/keskus`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('#agents .agent .title')].some((t) => t.textContent === 'E2E tarkennus'), { timeout: 8000 });
  await page.evaluate(() => [...document.querySelectorAll('#agents .agent')].find((r) => r.querySelector('.title').textContent === 'E2E tarkennus').click());
  await page.waitForFunction(() => document.querySelector('#agents .panel h2')?.textContent === 'E2E tarkennus');
  assert.equal(await page.$eval('#view-title', (e) => e.textContent), 'Komentokeskus');
  await page.click(".nav a[data-view=taulu]");
  await page.waitForFunction(() => getComputedStyle(document.getElementById('agents')).display === 'none' && getComputedStyle(document.getElementById('board')).display !== 'none');
  assert.equal(await page.$eval('#view-title', (e) => e.textContent), 'Taulu');
  assert.deepEqual(errors, []);
});

test('the changes view shows the diff of a card in review and offers the approval', async () => {
  const p = await browser.newPage();
  const now = new Date().toISOString();
  const card = { id: 'c-fake', title: 'Lisää alennusfunktio', brief: '', repos: ['harjoitus'], priority: 'normal', after: null, model: null, effort: null, status: 'review', createdAt: now, updatedAt: now };
  const patch = ['diff --git a/price.js b/price.js', 'index 1..2 100644', '--- a/price.js', '+++ b/price.js', '@@ -3,3 +3,5 @@',
    ' export function total() {', '-  old', '+  new', ' }', '+export function discounted(a, p) {', '+}', ''].join('\n');
  const run = { state: 'finished', agentId: 'a1', startedAt: now, worktrees: [{ repo: 'harjoitus', path: 'x', branch: 'ac/c-fake', base: 'main' }],
    review: { state: 'done', round: 0, findings: [], summary: 'Kaikki kunnossa', cost: 0.03 } };
  await p.setRequestInterception(true);
  p.on('request', (r) => {
    const u = new URL(r.url());
    const json = (body) => r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/api/cards' && r.method() === 'GET') return json([card]);
    if (u.pathname === '/api/cards/c-fake/run') return json({ run, report: null, question: null, commitMessage: 'Lisää alennusfunktio', followups: null, prs: [], localMerge: true });
    if (u.pathname === '/api/cards/c-fake/diff') return json({ repos: [{ repo: 'harjoitus', branch: 'ac/c-fake', base: 'main', stat: '', patch, truncated: false }] });
    return r.continue();
  });
  await p.goto(`${base}/?view=changes#/muutokset`, { waitUntil: 'networkidle0' });
  await p.waitForSelector('#changes .dl.add', { timeout: 8000 });
  assert.equal(await p.$eval('#changes .chead h2', (e) => e.textContent), 'Lisää alennusfunktio');
  assert.equal(await p.$eval('#nav-changes', (e) => e.textContent), '1');
  assert.deepEqual(await p.$$eval('#changes .dl.add, #changes .dl.del', (rows) => rows.map((r) => r.className.split(' ')[1])), ['del', 'add', 'add', 'add']);
  assert.equal(await p.$eval('#changes .dl.add .no:nth-child(2)', (e) => e.textContent), '4', 'new line number comes from the hunk header');
  assert.ok(await p.$$eval('#changes .chead button', (bs) => bs.some((b) => b.textContent === 'Hyväksy työ projektiin')));
  assert.match(await p.$eval('#changes .alert', (e) => e.textContent), /Kaikki kunnossa/);
  await p.close();
});

test('the settings page changes the day limit on the server and holds the voice switches', async () => {
  server.ledger.record('agent', { input: 1200, output: 3400, cacheRead: 50000, cacheWrite: 800 }, { card: 'c-x' });
  await page.goto(`${base}/?view=settings#/asetukset`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#set-runner .stepper button');
  const day = () => page.evaluate(async () => (await (await fetch('/api/settings')).json()).runner.dayLimit);
  const before = await day();
  await page.click('#set-runner button[aria-label="Lisää: Päiväraja"]');
  await page.waitForFunction((n) => document.querySelector('#set-runner .stepper .mono').textContent === String(n), {}, before + 1);
  assert.equal(await day(), before + 1);
  assert.match(await page.$eval('#set-runner .state', (e) => e.textContent), /Tallennettu/);
  await page.waitForFunction(() => document.querySelector('#set-usage')?.textContent.includes('5,4 k'));
  assert.match(await page.$eval('#set-usage', (e) => e.textContent), /Tokenien käyttö[\s\S]*Toteutusagentit/);
  assert.ok(await page.$('#settings #voice-toggle'), 'voice switches live on the settings page');
  assert.equal(await page.$eval('#view-title', (e) => e.textContent), 'Asetukset');
  assert.deepEqual(errors, []);
});

test('the dependency view draws the chains and a finished plan is approved from the "your turn" list', async () => {
  const { writeFile } = await import('node:fs/promises');
  const first = await server.store.create({ title: 'Ketjun alku', repos: ['repo-a'] });
  const second = await server.store.create({ title: 'Ketjun toinen', repos: ['repo-a'], after: first.id });
  await server.store.create({ title: 'Ketjun kolmas', repos: ['repo-a'], after: second.id });
  await server.store.update(first.id, { status: 'refining' });
  await writeFile(join(dir, 'data', 'cards', first.id, 'refine.json'), JSON.stringify({ state: 'idle', turn: 1, summary: 's', questions: [], plan: 'Tee näin ja näin', ready: true, history: [], cost: 0 }));

  await page.goto(`${base}/#/riippuvuudet`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#graph .g-node');
  assert.equal(await page.$$eval('#graph .g-node', (n) => n.length), 3);
  assert.equal(await page.$$eval('#graph .g-edge.blocking', (n) => n.length), 2, 'both links still wait for their predecessor');
  assert.ok(await page.$('#graph .g-edge.crit'), 'the chain is the critical path');

  await page.goto(`${base}/#/keskus`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#next .next-item.plan');
  await page.click('#next .next-item.plan summary');
  await page.waitForFunction(() => document.querySelector('#next .plan-body')?.textContent.includes('Tee näin ja näin'));
  await page.click('#next .next-item.plan button.primary');
  await page.waitForFunction(async () => (await (await fetch('/api/cards')).json()).some((c) => c.title === 'Ketjun alku' && c.status === 'ready'));
  assert.deepEqual(errors, []);
});

test('the sandbox keeps a drawing over a reload and shows it to the AI only from its button', async () => {
  await page.evaluate(() => fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'piirto' }) }));
  await page.goto(`${base}/#/sandbox`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('#sb-project option')].some((o) => o.value === 'piirto'));
  await page.select('#sb-project', 'piirto');
  await page.waitForFunction(() => !document.getElementById('sb-share').disabled);
  assert.equal(await page.$eval('#chat-dock', (e) => getComputedStyle(e).display), 'none', 'the orchestrator steps aside');

  await page.$eval('#sb-canvas', (c) => c.scrollIntoView({ block: 'center' }));
  const box = await (await page.$('#sb-canvas')).boundingBox();
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/sandbox/piirto/canvas') && r.request().method() === 'PUT');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.06), box.y + box.height * 0.5);
  await page.mouse.up();
  assert.equal((await saved).status(), 200);

  await page.reload({ waitUntil: 'networkidle0' });
  // The line through the middle is drawn again from the saved strokes.
  await page.waitForFunction(() => {
    const c = document.getElementById('sb-canvas');
    if (!c.width) return false;
    const px = c.getContext('2d').getImageData(Math.round(c.width * 0.5) - 3, Math.round(c.height * 0.5) - 3, 7, 7).data; // around the middle
    return px.some((v, i) => i % 4 === 3 && v > 200);
  }, { timeout: 5000 });
  assert.equal(await page.$eval('#sb-log', (e) => e.querySelectorAll('.me').length), 0, 'drawing alone sends nothing');

  await page.click('#sb-share');
  await page.waitForSelector('#sb-log img.sb-thumb', { timeout: 8000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#sb-log .bot')].some((b) => /Näen piirroksen/.test(b.textContent)), { timeout: 8000 });
  assert.ok(await page.$eval('#sb-log img.sb-thumb', (img) => img.complete && img.naturalWidth > 0), 'the thumbnail loads');
  await page.goto(`${base}/#/keskus`, { waitUntil: 'networkidle0' });
  assert.notEqual(await page.$eval('#chat-dock', (e) => getComputedStyle(e).display), 'none');
  assert.deepEqual(errors, []);
});

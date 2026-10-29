import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';
import { MAX_IMAGE } from '../lib/attachments.js';

const fakeSandbox = fileURLToPath(new URL('./fake-sandbox-claude.js', import.meta.url));
const sandboxMcp = fileURLToPath(new URL('../lib/sandbox-mcp.js', import.meta.url));
const token = 't';
const headers = { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' };
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const stroke = { color: '#000000', width: 3, points: [[0.1, 0.1], [0.5, 0.5]] };

function startApp(dir) {
  const server = createApp({ dataDir: join(dir, 'data'), token, reposRoot: join(dir, 'repos'), claude: createClaude({ command: process.execPath, prefixArgs: [fakeSandbox] }) });
  return new Promise((r) => server.listen(0, '127.0.0.1', r)).then(() => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const type = res.headers.get('content-type') ?? '';
      return { status: res.status, type, body: type.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    return { server, base, call };
  });
}

describe('sandbox', () => {
  let dir, logFile, app;
  const invocations = async () => (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const close = (a) => new Promise((r) => a.server.close(r));

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcontrol-sandbox-'));
    await mkdir(join(dir, 'repos'), { recursive: true });
    logFile = join(dir, 'fake.log');
    process.env.FAKE_LOG = logFile;
    app = await startApp(dir);
    assert.equal((await app.call('POST', '/api/projects', { name: 'sb' })).status, 201);
    assert.equal((await app.call('POST', '/api/projects', { name: 'other' })).status, 201);
  });
  after(async () => {
    await close(app);
    await rm(dir, { recursive: true, force: true });
  });

  test('starts empty', async () => {
    const res = await app.call('GET', '/api/sandbox/sb');
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.chat, res.body.canvas, res.body.busy], [[], { strokes: [], rev: 0 }, false]);
  });

  test('a message runs claude read-only in the project, with the sandbox tool, and the chat keeps both sides', async () => {
    const res = await app.call('POST', '/api/sandbox/sb/chat', { text: 'mitä jos lisättäisiin haku?' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, 'Selvä: mitä jos lisättäisiin haku?');
    assert.deepEqual(res.body.confirmations, []);

    const run = (await invocations()).at(-1);
    const repo = realpathSync.native(join(dir, 'repos', 'sb'));
    const addDirs = run.args.flatMap((a, i) => (a === '--add-dir' ? [run.args[i + 1]] : []));
    assert.deepEqual(addDirs, [realpathSync.native(join(dir, 'data', 'sandbox', 'sb')), repo]);
    assert.equal(realpathSync.native(run.cwd), repo);
    const allowed = run.args.slice(run.args.indexOf('--allowedTools') + 1, run.args.indexOf('--disallowedTools'));
    assert.deepEqual(allowed, ['Read', 'Grep', 'Glob', 'mcp__sandbox']);
    const denied = run.args.slice(run.args.indexOf('--disallowedTools') + 1, run.args.indexOf('--setting-sources'));
    for (const t of ['Bash', 'Edit', 'Write']) assert.ok(denied.includes(t), t);
    assert.ok(run.args.includes('--strict-mcp-config'));
    assert.ok(!run.args.includes('--resume'));
    assert.match(run.prompt, /^\[Project: sb, repository /);
    assert.doesNotMatch(run.prompt, /canvas/, 'a plain message never carries the drawing');
    assert.deepEqual(run.mcp.mcpServers.sandbox.args, [sandboxMcp]);

    await app.call('POST', '/api/sandbox/sb/chat', { text: 'toinen' });
    const second = (await invocations()).at(-1);
    assert.match(second.args[second.args.indexOf('--resume') + 1], /^sb-/);

    const chat = (await app.call('GET', '/api/sandbox/sb')).body.chat;
    assert.deepEqual(chat.map((m) => [m.who, m.text]), [['me', 'mitä jos lisättäisiin haku?'], ['bot', 'Selvä: mitä jos lisättäisiin haku?'], ['me', 'toinen'], ['bot', 'Selvä: toinen']]);
  });

  test('saving the canvas stores it and never runs claude', async () => {
    const before = (await invocations()).length;
    const res = await app.call('PUT', '/api/sandbox/sb/canvas', { strokes: [stroke] });
    assert.equal(res.status, 200);
    assert.equal(res.body.rev, 1);
    const state = (await app.call('GET', '/api/sandbox/sb')).body;
    assert.deepEqual(state.canvas.strokes, [stroke]);
    assert.equal(state.chat.length, 4, 'no chat line');
    assert.equal((await invocations()).length, before);

    assert.equal((await app.call('PUT', '/api/sandbox/sb/canvas', { strokes: 'x' })).status, 400);
    assert.equal((await app.call('PUT', '/api/sandbox/sb/canvas', { strokes: [{ ...stroke, color: 'red;' }] })).status, 400);
    assert.equal((await app.call('PUT', '/api/sandbox/sb/canvas', { strokes: [{ ...stroke, points: [[0, 'a']] }] })).status, 400);
    assert.equal((await app.call('DELETE', '/api/sandbox/sb/canvas')).body.rev, 2);
    assert.deepEqual((await app.call('GET', '/api/sandbox/sb')).body.canvas.strokes, []);
  });

  test('sharing the drawing saves the PNG and points the AI at it', async () => {
    assert.equal((await app.call('POST', '/api/sandbox/sb/share', { png: Buffer.from('hello').toString('base64') })).status, 400);
    const tooBig = Buffer.alloc(MAX_IMAGE + 1);
    Buffer.from(PNG, 'base64').copy(tooBig);
    assert.equal((await app.call('POST', '/api/sandbox/sb/share', { png: tooBig.toString('base64') })).status, 400);

    const res = await app.call('POST', '/api/sandbox/sb/share', { png: PNG, text: 'Mitä tässä on?' });
    assert.equal(res.status, 200);
    const file = join(dir, 'data', 'sandbox', 'sb', 'shared', 'canvas-1.png');
    assert.deepEqual(await readFile(file), Buffer.from(PNG, 'base64'));
    assert.equal(res.body.reply, `Näen piirroksen (${Buffer.from(PNG, 'base64').length} tavua)`, 'the AI read the file it was pointed at');
    const run = (await invocations()).at(-1);
    assert.ok(run.prompt.includes(realpathSync.native(file)));
    assert.match(run.prompt, /Mitä tässä on\?$/);

    const img = await app.call('GET', '/api/sandbox/sb/image/canvas-1.png');
    assert.equal(img.status, 200);
    assert.equal(img.type, 'image/png');
    assert.deepEqual(img.body, Buffer.from(PNG, 'base64'));
    assert.equal((await app.call('GET', '/api/sandbox/sb/image/canvas-9.png')).status, 404);
    const me = (await app.call('GET', '/api/sandbox/sb')).body.chat.filter((m) => m.who === 'me').at(-1);
    assert.deepEqual([me.text, me.image], ['Mitä tässä on?', 'canvas-1.png']);

    await app.call('POST', '/api/sandbox/sb/share', { png: PNG });
    assert.match((await invocations()).at(-1).prompt, /canvas-2\.png[\s\S]*Katso piirrostani\.$/, 'each share is a file of its own');
  });

  test('a proposed card waits for the person: nothing is created until they press OK', async () => {
    const before = (await app.call('GET', '/api/cards')).body.length;
    const res = await app.call('POST', '/api/sandbox/sb/chat', { text: 'PROPOSE kortti' });
    assert.deepEqual(res.body.confirmations, [{ tool: 'propose_card', args: { title: 'Piirrosidea', description: 'Tehdään se', attachCanvas: true } }]);
    assert.deepEqual(res.body.tools, ['propose_card']);
    assert.equal((await app.call('GET', '/api/cards')).body.length, before);

    // What the page does on OK:
    const card = await app.call('POST', '/api/sandbox/sb/card', { title: 'Piirrosidea', description: 'Tehdään se', image: 'canvas-1.png' });
    assert.equal(card.status, 201);
    assert.deepEqual([card.body.status, card.body.repos, card.body.brief], ['inbox', ['sb'], 'Tehdään se']);
    assert.equal((await app.call('GET', `/api/cards/${card.body.id}/attachments`)).body.length, 1);
    // The next message tells the AI what was pressed, without putting it in the chat log.
    await app.call('POST', '/api/sandbox/sb/chat', { text: 'kiitos', notes: 'OK: card "Piirrosidea" created in the Inbox.' });
    assert.match((await invocations()).at(-1).prompt, /\[Popups since your last reply: OK: card "Piirrosidea" created in the Inbox\.\]\nkiitos$/);
    assert.equal((await app.call('GET', '/api/sandbox/sb')).body.chat.filter((m) => m.who === 'me').at(-1).text, 'kiitos');

    assert.equal((await app.call('POST', '/api/sandbox/sb/card', { title: '' })).status, 400);
    assert.equal((await app.call('POST', '/api/sandbox/sb/card', { title: 'x', image: '../state.json' })).status, 404);
  });

  test('unknown projects and paths are not found', async () => {
    assert.equal((await app.call('GET', '/api/sandbox/eiole')).status, 404);
    assert.equal((await app.call('GET', '/api/sandbox/..%2Fsb')).status, 404);
    assert.equal((await app.call('PUT', '/api/sandbox/..%2F..%2Fx/canvas', { strokes: [] })).status, 404);
    assert.equal((await app.call('POST', '/api/sandbox/sb/chat', { text: ' ' })).status, 400);
  });

  test('each project has its own sandbox, and a reset starts a new session', async () => {
    assert.deepEqual((await app.call('GET', '/api/sandbox/other')).body.chat, []);
    assert.equal((await app.call('POST', '/api/sandbox/sb/reset')).status, 200);
    await app.call('POST', '/api/sandbox/sb/chat', { text: 'alusta' });
    const run = (await invocations()).at(-1);
    assert.ok(!run.args.includes('--resume'));
    assert.ok((await app.call('GET', '/api/sandbox/sb')).body.chat.some((m) => m.sep));
  });

  test('a session that no longer exists is replaced by a new one', async () => {
    await mkdir(join(dir, 'data', 'sandbox', 'other'), { recursive: true });
    await writeFile(join(dir, 'data', 'sandbox', 'other', 'state.json'), JSON.stringify({ sessionId: 'gone-session', cost: 0, turns: 1 }));
    assert.equal((await app.call('POST', '/api/sandbox/other/chat', { text: 'hei' })).status, 200);
    const runs = (await invocations()).slice(-2);
    assert.deepEqual(runs.map((r) => r.args.includes('--resume')), [true, false], 'tried the old one, then started anew');
  });

  test('a crash keeps the conversation: the next message resumes the same session', async () => {
    await app.call('POST', '/api/sandbox/sb/chat', { text: 'ennen' });
    const session = (await invocations()).at(-1).args;
    const id = session[session.indexOf('--resume') + 1];
    const before = (await invocations()).length;
    const res = await app.call('POST', '/api/sandbox/sb/chat', { text: 'CRASH' });
    assert.equal(res.status, 500);
    assert.equal((await invocations()).length, before + 1, 'no second, fresh run');
    await app.call('POST', '/api/sandbox/sb/chat', { text: 'jälkeen' });
    const after = (await invocations()).at(-1).args;
    assert.equal(after[after.indexOf('--resume') + 1], id);
    assert.ok((await app.call('GET', '/api/sandbox/sb')).body.chat.some((m) => m.error && /ei vastannut/.test(m.text)), 'the failure shows in the chat');
  });

  test('a large drawing within the stroke limits is saved', async () => {
    const big = Array.from({ length: 100 }, () => ({ color: '#123456', width: 4, points: Array.from({ length: 800 }, (_, i) => [i / 800 + 0.00001, 0.12345]) }));
    assert.ok(JSON.stringify({ strokes: big }).length > 1_000_000);
    const res = await app.call('PUT', '/api/sandbox/other/canvas', { strokes: big });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await app.call('GET', '/api/sandbox/other')).body.canvas.strokes.length, 100);
    await app.call('DELETE', '/api/sandbox/other/canvas');
  });

  test('a refused share leaves no image behind', async () => {
    const shared = join(dir, 'data', 'sandbox', 'sb', 'shared');
    const files = async () => (await readdir(shared)).sort();
    const was = await files();
    assert.equal((await app.call('POST', '/api/sandbox/sb/share', { png: PNG, text: 'x'.repeat(4001) })).status, 400);
    assert.deepEqual(await files(), was);
  });

  test('an image that cannot be attached stops the card before it is made', async () => {
    const cards = (await app.call('GET', '/api/cards')).body.length;
    const tooBig = Buffer.alloc(MAX_IMAGE + 1);
    Buffer.from(PNG, 'base64').copy(tooBig);
    await writeFile(join(dir, 'data', 'sandbox', 'sb', 'shared', 'canvas-90.png'), tooBig);
    assert.equal((await app.call('POST', '/api/sandbox/sb/card', { title: 'Iso', image: 'canvas-90.png' })).status, 400);
    assert.equal((await app.call('GET', '/api/cards')).body.length, cards, 'no card without its drawing');
  });

  test('the project name is the project\'s own, whatever the casing in the address', { skip: process.platform !== 'win32' && 'names are case-sensitive here' }, async () => {
    const upper = await app.call('GET', '/api/sandbox/SB');
    assert.equal(upper.status, 200, 'on Windows the project folder, and so the project, is found whatever the casing');
    assert.deepEqual(upper.body.chat, (await app.call('GET', '/api/sandbox/sb')).body.chat);
    await app.call('PUT', '/api/sandbox/SB/canvas', { strokes: [stroke] });
    assert.ok(existsSync(join(dir, 'data', 'sandbox', 'sb', 'canvas.json')));
    const names = await readdir(join(dir, 'data', 'sandbox'));
    assert.ok(!names.includes('SB'), 'one folder for the project');
  });

  test('everything survives a restart', async () => {
    await app.call('PUT', '/api/sandbox/sb/canvas', { strokes: [stroke, stroke] });
    const was = (await app.call('GET', '/api/sandbox/sb')).body;
    await close(app);
    app = await startApp(dir);
    const now = (await app.call('GET', '/api/sandbox/sb')).body;
    assert.deepEqual([now.chat, now.canvas.strokes], [was.chat, was.canvas.strokes]);
    await app.call('POST', '/api/sandbox/sb/chat', { text: 'jatketaan' });
    assert.ok((await invocations()).at(-1).args.includes('--resume'), 'the conversation goes on');
  });
});

describe('sandbox tool (MCP server)', () => {
  test('propose_card only asks: it answers NEEDS_CONFIRMATION', async () => {
    const mcp = spawn(process.execPath, [sandboxMcp], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = [];
    mcp.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
    const send = (msg) => mcp.stdin.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose_card', arguments: { title: 'Haku', description: 'Hakukenttä' } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose_card', arguments: {} } });
    mcp.stdin.end();
    await new Promise((r) => mcp.on('close', r));
    const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    assert.deepEqual(byId[2].result.tools.map((t) => t.name), ['propose_card']);
    const text = byId[3].result.content[0].text;
    assert.deepEqual(JSON.parse(text.match(/^NEEDS_CONFIRMATION (\{.*\})$/m)[1]), { tool: 'propose_card', args: { title: 'Haku', description: 'Hakukenttä', attachCanvas: false } });
    assert.match(text, /popup with an OK button/);
    assert.equal(byId[4].result.isError, true);
  });
});

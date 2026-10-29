import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';

const fakeOrchestrator = fileURLToPath(new URL('./fake-orchestrator.js', import.meta.url));
const fakeClaude = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const boardMcp = fileURLToPath(new URL('../lib/board-mcp.js', import.meta.url));
const token = 't';
const headers = { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' };

async function startApp(dir, fake) {
  await mkdir(join(dir, 'repos', 'repo-a'), { recursive: true });
  const server = createApp({ dataDir: join(dir, 'data'), token, reposRoot: join(dir, 'repos'), claude: createClaude({ command: process.execPath, prefixArgs: [fake] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { server, base, call };
}

describe('orchestrator', () => {
  let dir, logFile, app;
  const invocations = async () => (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcontrol-orch-'));
    logFile = join(dir, 'fake.log');
    process.env.FAKE_LOG = logFile;
    app = await startApp(dir, fakeOrchestrator);
  });
  after(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  test('a message runs claude with only the board tools, and the reply comes back', async () => {
    const res = await app.call('POST', '/api/orchestrator', { text: 'mitä taululla on', screen: 'the board' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, 'Selvä: mitä taululla on');
    assert.deepEqual(res.body.tools, ['board_overview']);

    const run = (await invocations()).at(-1);
    assert.ok(run.args.includes('--strict-mcp-config'), 'none of the user\'s own MCP servers');
    assert.equal(run.args[run.args.indexOf('--allowedTools') + 1], 'mcp__board');
    assert.ok(run.args.includes('Bash') && run.args.includes('Edit'), 'no shell or file edits');
    assert.equal(run.args[run.args.indexOf('--model') + 1], 'sonnet');
    assert.ok(!run.args.includes('--resume'));
    assert.match(run.prompt, /^\[Screen: the board\]\nmitä taululla on$/);
    const board = run.mcp.mcpServers.board;
    assert.equal(board.command, process.execPath);
    assert.deepEqual(board.args, [boardMcp]);
    assert.equal(board.env.AGENTCONTROL_URL, app.base, 'the tools call this server back');
    assert.equal(board.env.AGENTCONTROL_TOKEN, token);
  });

  test('the conversation continues in the same session until it is reset', async () => {
    await app.call('POST', '/api/orchestrator', { text: 'eka' });
    const { sessionId } = (await app.call('GET', '/api/orchestrator')).body;
    assert.match(sessionId, /^orch-/);
    await app.call('POST', '/api/orchestrator', { text: 'toka' });
    const second = (await invocations()).at(-1);
    assert.equal(second.args[second.args.indexOf('--resume') + 1], sessionId);

    assert.equal((await app.call('POST', '/api/orchestrator/reset')).status, 200);
    await app.call('POST', '/api/orchestrator', { text: 'alusta' });
    assert.ok(!(await invocations()).at(-1).args.includes('--resume'));
  });

  test('a session that no longer exists is replaced by a new one', async () => {
    await writeFile(join(dir, 'data', 'orchestrator.json'), JSON.stringify({ sessionId: 'gone-session', cost: 0, turns: 3 }));
    const res = await app.call('POST', '/api/orchestrator', { text: 'hei' });
    assert.equal(res.status, 200);
    assert.notEqual((await app.call('GET', '/api/orchestrator')).body.sessionId, 'gone-session');
  });

  test('messages are handled one at a time, in order', async () => {
    const [a, b] = await Promise.all([app.call('POST', '/api/orchestrator', { text: 'A' }), app.call('POST', '/api/orchestrator', { text: 'B' })]);
    assert.deepEqual([a.body.reply, b.body.reply], ['Selvä: A', 'Selvä: B']);
    assert.deepEqual((await invocations()).slice(-2).map((i) => i.prompt.split('\n').at(-1)), ['A', 'B']);
  });

  test('a step that needs the person\'s OK comes back once, for the page to ask with a popup', async () => {
    const res = await app.call('POST', '/api/orchestrator', { text: 'CONFIRM tämä' });
    assert.deepEqual(res.body.confirmations, [{ tool: 'start_refinement', args: { id: 'c-b' }, confirm: true, blockedBy: { id: 'c-a', title: 'A', status: 'inbox' }, afterKind: 'done' }]);
    assert.deepEqual((await app.call('POST', '/api/orchestrator', { text: 'tavallinen' })).body.confirmations, []);
  });

  test('errors are readable', async () => {
    const broken = await app.call('POST', '/api/orchestrator', { text: 'BROKEN' });
    assert.equal(broken.status, 502);
    assert.match(broken.body.error, /model overloaded/);
    assert.equal((await app.call('POST', '/api/orchestrator', { text: ' ' })).status, 400);
  });
});

describe('board tools (MCP server)', () => {
  let dir, app, mcp, nextId = 1;
  const waiting = new Map();
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const tool = async (name, args) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    return { error: r.isError === true, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcontrol-mcp-'));
    process.env.FAKE_LOG = join(dir, 'fake.log'); // the previous suite's log folder is gone
    app = await startApp(dir, fakeClaude);
    mcp = spawn(process.execPath, [boardMcp], { env: { ...process.env, AGENTCONTROL_URL: app.base, AGENTCONTROL_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    mcp.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        waiting.get(msg.id)?.(msg);
      }
    });
  });
  after(async () => {
    mcp.kill();
    await app.server.refiner.settled();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  test('speaks MCP: initialize, then a list of tools with schemas', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const { tools } = (await rpc('tools/list')).result;
    for (const name of ['board_overview', 'next_steps', 'create_card', 'start_refinement', 'start_work', 'answer_agent', 'create_project', 'plan_project']) {
      assert.ok(tools.some((t) => t.name === name && t.inputSchema.type === 'object'), name);
    }
    assert.ok(!tools.some((t) => /pull|push|archive|remove/i.test(t.name)), 'nothing outward-facing');
    assert.deepEqual(tools.filter((t) => /delete/.test(t.name)).map((t) => t.name), ['delete_project'], 'the one delete only asks for a popup OK (tested below)');
    assert.equal((await rpc('no/such')).error.code, -32601);
  });

  test('cards with a dependency, and refining that waits for confirmation', async () => {
    const a = (await tool('create_card', { title: 'A', repos: ['repo-a'] })).json;
    const b = (await tool('create_card', { title: 'B', repos: ['repo-a'], after: a.id, afterKind: 'planned' })).json;
    assert.deepEqual([b.after, b.afterKind, b.status], [a.id, 'planned', 'inbox']);

    const blocked = await tool('start_refinement', { id: b.id });
    assert.equal(blocked.error, true);
    const data = JSON.parse(blocked.text.match(/^NEEDS_CONFIRMATION (\{.*\})$/m)[1]);
    assert.deepEqual([data.tool, data.args, data.blockedBy.id, data.afterKind], ['start_refinement', { id: b.id }, a.id, 'planned']);
    assert.match(blocked.text, /popup with an OK button/, 'the model is told not to ask in chat');
    assert.equal((await app.call('GET', `/api/cards/${b.id}`)).body.status, 'inbox');
    assert.equal((await tool('start_refinement', { id: b.id, confirmed: true })).error, true, 'the model cannot confirm for the person');

    // What the page does when the person presses OK in the popup:
    assert.equal((await app.call('POST', `/api/cards/${b.id}/refine/start`, { confirmed: true })).status, 202);
    await app.server.refiner.settled();
    const overview = (await tool('board_overview', {})).json;
    assert.equal(overview.cards.find((c) => c.id === b.id).status, 'refining');
    assert.equal(typeof overview.dispatcher.limit, 'number');

    const full = (await tool('get_card', { id: b.id })).json;
    assert.equal(full.refinement.questions.length, 1, 'the refiner\'s questions, to relay to the person');
  });

  test('next_steps gives the same list the person sees, with card ids to act on', async () => {
    const c = (await tool('create_card', { title: 'Vuorossa', repos: ['repo-a'] })).json;
    const next = (await tool('next_steps', {})).json;
    assert.ok(Array.isArray(next.yourTurn) && Array.isArray(next.working) && Array.isArray(next.waiting));
    const entry = next.yourTurn.find((x) => x.what === 'Inbox' && x.card);
    assert.ok(entry, JSON.stringify(next));
    assert.ok(entry.action && entry.title);
    assert.ok(c.id);
  });

  test('deleting a project only asks: the person confirms in a popup', async () => {
    await app.call('POST', '/api/projects', { name: 'mcp-gone' });
    const asked = await tool('delete_project', { name: 'mcp-gone' });
    assert.equal(asked.error, true);
    const data = JSON.parse(asked.text.match(/^NEEDS_CONFIRMATION (\{.*\})$/m)[1]);
    assert.deepEqual([data.tool, data.project], ['delete_project', 'mcp-gone']);
    assert.equal((await app.call('GET', '/api/projects/mcp-gone')).status, 200, 'nothing was deleted');
    assert.match((await tool('delete_project', { name: 'nope' })).text, /^Error \(404\)/);
  });

  test('get_project includes the code map once the project was explored', async () => {
    await app.call('POST', '/api/projects', { name: 'mcp-map' });
    assert.equal((await tool('get_project', { name: 'mcp-map' })).json.codeMap, null, 'not explored yet');
    const mapDir = join(dir, 'data', 'projects', 'mcp-map', 'map');
    await mkdir(mapDir, { recursive: true });
    await writeFile(join(mapDir, 'map.json'), JSON.stringify({ state: 'ready', exploredAt: '2026-10-28T10:00:00Z', repos: [] }));
    await writeFile(join(mapDir, 'MAP.md'), '# Sähköliitto\n\nJäsenrekisteri.\n');
    const p = (await tool('get_project', { name: 'mcp-map' })).json;
    assert.equal(p.codeMap.exploredAt, '2026-10-28T10:00:00Z');
    assert.match(p.codeMap.text, /Jäsenrekisteri/);
  });

  test('recent_commits lists the latest commits of a project\'s repository', async () => {
    const out = (await tool('recent_commits', { name: 'repo-a' }));
    assert.equal(out.error, true, 'repo-a is a repository, not a project');
    const repo = join(dir, 'repos', 'mcp-git');
    await mkdir(repo, { recursive: true });
    const sh = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    sh('init', '-q', '-b', 'main');
    await writeFile(join(repo, 'a.txt'), 'x');
    sh('add', '.');
    sh('commit', '-qm', 'first');
    await writeFile(join(repo, 'a.txt'), 'y');
    sh('commit', '-qam', 'second change');
    await app.call('POST', '/api/projects/existing', { path: repo });
    const r = (await tool('recent_commits', { name: 'mcp-git' })).json;
    assert.equal(r[0].branch, 'main');
    assert.deepEqual(r[0].commits.map((c) => [c.subject, c.author]), [['second change', 't'], ['first', 't']], 'newest first');

    const d = (await tool('commit_details', { name: 'mcp-git', sha: r[0].commits[0].sha })).json;
    assert.equal(d.message, 'second change');
    assert.match(d.stat, /a\.txt/);
    assert.match(d.patch, /^-x$[\s\S]*^\+y$/m, 'the change itself');
    assert.equal((await tool('commit_details', { name: 'mcp-git', sha: 'deadbeef' })).error, true, 'an unknown commit is an error');
    assert.equal((await tool('commit_details', { name: 'mcp-git', sha: '--help' })).error, true, 'only hex is accepted');
  });

  test('the board\'s rules still apply: illegal moves are refused', async () => {
    const c = (await tool('create_card', { title: 'C' })).json;
    const moved = await tool('move_card', { id: c.id, status: 'running' });
    assert.equal(moved.error, true);
    assert.match(moved.text, /^Error \(400\)/);
    assert.equal((await tool('move_card', { id: c.id, status: 'archive' })).json.status, 'archive');
  });
});

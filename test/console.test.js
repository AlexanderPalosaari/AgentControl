import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createAgentConsole, toolSummary, transcriptEntries } from '../lib/console.js';
import { projectDirName } from '../lib/usage.js';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'agentcontrol-console-')); });
after(() => rm(dir, { recursive: true, force: true }));

const line = (o) => JSON.stringify(o) + '\n';
const assistant = (content, extra = {}) => ({ type: 'assistant', timestamp: '2026-11-10T10:00:00.000Z', message: { role: 'assistant', content }, ...extra });
const user = (content) => ({ type: 'user', timestamp: '2026-11-10T10:00:01.000Z', message: { role: 'user', content } });
const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail('timed out');
};

describe('transcript lines', () => {
  test('text, thinking, tool calls, their output and prompts become console entries; bookkeeping does not', () => {
    const got = transcriptEntries(assistant([
      { type: 'thinking', thinking: 'Mietin ensin rakennetta' },
      { type: 'thinking', thinking: '', signature: 'xyz' }, // redacted: nothing to show
      { type: 'text', text: 'Luen tiedoston.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm   test', description: 'Run tests' } },
    ]));
    assert.deepEqual(got.map((e) => [e.kind, e.text ?? e.summary]), [['thinking', 'Mietin ensin rakennetta'], ['text', 'Luen tiedoston.'], ['tool', 'npm test']]);
    assert.equal(got[2].name, 'Bash');
    assert.equal(got[0].t, '2026-11-10T10:00:00.000Z');

    const out = transcriptEntries(user([{ type: 'tool_result', content: 'x'.repeat(2000), is_error: true }]));
    assert.equal(out[0].kind, 'output');
    assert.equal(out[0].error, true);
    assert.ok(out[0].text.length < 700, 'output is only a glimpse');
    assert.deepEqual(transcriptEntries(user('Read prompt.md and carry out the task')).map((e) => e.kind), ['user']);
    assert.deepEqual(transcriptEntries({ type: 'permission-mode', mode: 'auto' }), []);
    assert.equal(transcriptEntries(assistant([{ type: 'text', text: 'sub' }], { isSidechain: true }))[0].sub, true);
  });

  test('a tool call is summed up by what it is about', () => {
    assert.equal(toolSummary('Read', { file_path: 'C:\\x\\a.js' }), 'C:\\x\\a.js');
    assert.equal(toolSummary('Grep', { pattern: 'foo', path: 'src' }), 'foo');
    assert.equal(toolSummary('WebFetch', { url: 'https://example.com', prompt: 'summarise' }), 'https://example.com');
  });
});

describe('live console', () => {
  test('lists the working agents and refiners, sends each one\'s recent lines, then new ones as they are written', async () => {
    const claudeDir = join(dir, 'claude');
    const cwd = join(dir, 'worktrees', 'c-a', 'repo');
    mkdirSync(cwd, { recursive: true });
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const transcriptDir = join(claudeDir, 'projects', projectDirName(cwd));
    mkdirSync(transcriptDir, { recursive: true });
    const file = join(transcriptDir, `${sessionId}.jsonl`);
    writeFileSync(file, line({ type: 'mode' }) + line(assistant([{ type: 'text', text: 'Aloitan.' }])));

    const cards = [
      { id: 'c-a', title: 'Toteuta haku', status: 'running', kind: 'task' },
      { id: 'c-b', title: 'Tarkenna raportti', status: 'refining', kind: 'task' },
      { id: 'c-c', title: 'Odottaa', status: 'ready', kind: 'task' },
    ];
    const runs = { 'c-a': { state: 'running', agentId: 'abcdef12', worktrees: [{ path: cwd }], startedAt: '2026-11-10T09:00:00Z', kind: 'task' } };
    let refinerFeed = null;
    const agentConsole = createAgentConsole({
      store: { list: async () => cards },
      runner: { run: async (id) => runs[id] ?? null, agentEntries: () => [{ id: 'abcdef12', sessionId }] },
      refiner: {
        busy: () => ['c-b'],
        liveTail: async () => [{ t: '2026-11-10T09:59:00Z', kind: 'turn', turn: 1 }],
        subscribeAll: (fn) => { refinerFeed = fn; return () => { refinerFeed = null; }; },
      },
      claudeDir, pollMs: 25,
    });

    const msgs = [];
    const stop = await agentConsole.subscribe((m) => msgs.push(m));
    const workers = msgs.find((m) => m.type === 'workers').workers;
    assert.deepEqual(workers.map((w) => [w.key, w.kind]), [['agent:c-a', 'agent'], ['refine:c-b', 'refine']]);
    assert.equal(workers[0].agentId, 'abcdef12');
    assert.equal('sessionId' in workers[0], false, 'internal fields stay on the server');
    assert.deepEqual(msgs.find((m) => m.type === 'backlog' && m.key === 'agent:c-a').entries.map((e) => e.text), ['Aloitan.']);
    assert.equal(msgs.find((m) => m.type === 'backlog' && m.key === 'refine:c-b').entries[0].kind, 'turn');

    appendFileSync(file, line(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } }])));
    await waitFor(() => msgs.some((m) => m.type === 'entry' && m.entry.kind === 'tool'));
    assert.equal(msgs.find((m) => m.type === 'entry' && m.entry.kind === 'tool').key, 'agent:c-a');

    refinerFeed('c-b', { kind: 'text', text: 'Luen koodia' });
    assert.ok(msgs.some((m) => m.type === 'entry' && m.key === 'refine:c-b' && m.entry.text === 'Luen koodia'));

    // The agent finishes: the workers change, and nothing more is read for it.
    cards[0].status = 'review';
    await waitFor(() => msgs.filter((m) => m.type === 'workers').length > 1);
    assert.deepEqual(msgs.findLast((m) => m.type === 'workers').workers.map((w) => w.key), ['refine:c-b']);

    stop();
    assert.equal(refinerFeed, null, 'nothing is watched once nobody looks');
  });

  test('a card\'s own feed has only its agent', async () => {
    const agentConsole = createAgentConsole({
      store: { list: async () => [{ id: 'c-x', title: 'X', status: 'refining' }] },
      runner: { run: async () => null, agentEntries: () => [] },
      refiner: { busy: () => ['c-x'], liveTail: async () => [], subscribeAll: () => () => {} },
      claudeDir: join(dir, 'none'), pollMs: 1000,
    });
    const msgs = [];
    const stop = await agentConsole.subscribe((m) => msgs.push(m), { card: 'c-x' });
    assert.deepEqual(msgs, [], 'the refiner is streamed by the card view itself');
    stop();
  });
});

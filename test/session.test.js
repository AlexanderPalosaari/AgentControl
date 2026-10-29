import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createKeyedQueue, runTurn, sessionGone } from '../lib/session.js';

const gone = { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['No conversation found with session ID: s1'] };
const ok = (id) => ({ type: 'result', is_error: false, result: 'hei', session_id: id });

/** A claude whose run answers from `answer(args)`, logging each call; events go to onEvent first. */
function fakeClaude(answer) {
  const calls = [];
  return {
    calls,
    run: async (opts) => {
      calls.push(opts);
      opts.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__x__t${calls.length}` }] } });
      return answer(opts);
    },
  };
}
const collect = () => { const tools = []; return { tools, onEvent: (e) => tools.push(e.message.content[0].name) }; };
const turn = (claude, sessionId) => runTurn({ claude, args: ['-p'], cwd: '.', sessionId, prompt: (fresh) => (fresh ? 'NEW' : 'GO'), collect });

describe('runTurn', () => {
  test('resumes the session it is given', async () => {
    const claude = fakeClaude(() => ok('s1'));
    const out = await turn(claude, 's1');
    assert.deepEqual(claude.calls.map((c) => [c.args, c.prompt]), [[['-p', '--resume', 's1'], 'GO']]);
    assert.equal(out.result.session_id, 's1');
  });

  test('a session that is gone (the CLI\'s error result) is replaced by a new one, with nothing left from the first try', async () => {
    const claude = fakeClaude((o) => (o.args.includes('--resume') ? gone : ok('s2')));
    const out = await turn(claude, 's1');
    assert.deepEqual(claude.calls.map((c) => [c.args, c.prompt]), [[['-p', '--resume', 's1'], 'GO'], [['-p'], 'NEW']]);
    assert.deepEqual(out.tools, ['mcp__x__t2'], 'only the run that counted');
    assert.equal(out.result.session_id, 's2');
  });

  test('so is one that throws saying so', async () => {
    const claude = fakeClaude((o) => { if (o.args.includes('--resume')) throw new Error('claude exited with code 1 without a result. No conversation found with session ID: s1'); return ok('s2'); });
    assert.equal((await turn(claude, 's1')).result.session_id, 's2');
  });

  test('any other failure is thrown and the session is not replaced', async () => {
    const crash = fakeClaude(() => { throw new Error('claude exited with code 1 without a result. killed'); });
    await assert.rejects(turn(crash, 's1'), /killed/);
    assert.equal(crash.calls.length, 1);
    const failed = fakeClaude(() => ({ type: 'result', is_error: true, result: 'model overloaded' }));
    assert.equal((await turn(failed, 's1')).result.result, 'model overloaded', 'the caller reports it; no second run');
    assert.equal(failed.calls.length, 1);
  });

  test('a run that hangs is stopped after the timeout', async () => {
    const claude = { run: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { aborted: true })))) };
    const err = await runTurn({ claude, args: [], cwd: '.', sessionId: null, prompt: () => 'x', collect, timeoutMs: 50 }).catch((e) => e);
    assert.equal(err.expose, true);
    assert.match(err.message, /ajo pysäytettiin/);
  });

  test('sessionGone reads both shapes', () => {
    assert.equal(sessionGone(gone), true);
    assert.equal(sessionGone(ok('s')), false);
    assert.equal(sessionGone({ is_error: true, result: 'overloaded' }), false);
    assert.equal(sessionGone(new Error('No conversation found with session ID: x')), true);
  });
});

test('the keyed queue runs one job per key at a time, keys in parallel, and survives a failure', async () => {
  const q = createKeyedQueue();
  const order = [];
  let release;
  const a1 = q.run('a', () => new Promise((r) => { release = r; }).then(() => order.push('a1')));
  const a2 = q.run('a', async () => order.push('a2'));
  await q.run('b', async () => order.push('b1'));
  assert.equal(q.busy('a'), true);
  assert.equal(q.busy('b'), false);
  release();
  await Promise.all([a1, a2]);
  assert.deepEqual(order, ['b1', 'a1', 'a2']);
  await assert.rejects(q.run('a', async () => { throw new Error('x'); }));
  assert.equal(await q.run('a', async () => 'next'), 'next');
  assert.equal(q.busy('a'), false);
});

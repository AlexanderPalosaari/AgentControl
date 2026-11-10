import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';
import { createReviewer, fixRequest, reviewMarkdown, verificationFinding } from '../lib/review.js';

const fake = fileURLToPath(new URL('./fake-agents.js', import.meta.url));
const token = 't';
const headers = { Cookie: `ac_token=${token}`, 'Content-Type': 'application/json' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

const GOOD_REPORT = '# Done\n\n## Verification\n- Tested: GET /api/price?x=1 returned 200 with the discounted total\n- Skipped: browser, the change has no UI\n';

const FINDING = { file: 'price.js', line: 7, severity: 'high', summary: 'discount divides by 10', failure_scenario: 'discounted(100, 10) returns 0' };

describe('review step in the run', () => {
  let dir, state, data, reposRoot, server, runner, base;
  const reviewer = { impl: null, calls: [], review: async (a) => { reviewer.calls.push(a); return reviewer.impl(a); } };
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const getCard = async (id) => (await call('GET', `/api/cards/${id}`)).body;
  const cardFile = (id, name) => join(data, 'cards', id, name);
  const getRun = (id) => JSON.parse(readFileSync(cardFile(id, 'run.json'), 'utf8'));
  const jobs = () => JSON.parse(readFileSync(join(state, 'jobs.json'), 'utf8'));
  const setJob = (id, patch) => {
    const all = jobs();
    const job = all.find((j) => j.id === id);
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete job[k]; else job[k] = v; }
    writeFileSync(join(state, 'jobs.json'), JSON.stringify(all));
  };
  const calls = () => readFileSync(join(state, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse);

  /** Starts a card and lets its agent "finish": report.md written, job idle. */
  async function finishedRun(report = GOOD_REPORT) {
    const card = (await call('POST', '/api/cards', { title: 'Add discount', repos: ['demo'] })).body;
    await server.store.update(card.id, { status: 'ready' });
    await runner.tick();
    const run = getRun(card.id);
    writeFileSync(cardFile(card.id, 'report.md'), report);
    setJob(run.agentId, { status: 'idle', state: 'done' });
    return { card, run };
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcontrol-review-'));
    state = join(dir, 'fake-state');
    data = join(dir, 'data');
    reposRoot = join(dir, 'repos');
    await mkdir(state, { recursive: true });
    await mkdir(reposRoot, { recursive: true });
    Object.assign(process.env, { FAKE_STATE: state, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
    sh(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    sh(reposRoot, 'clone', '-q', join(dir, 'origin.git'), 'demo');
    writeFileSync(join(reposRoot, 'demo', 'a.txt'), 'v1\n');
    sh(join(reposRoot, 'demo'), 'add', '.');
    sh(join(reposRoot, 'demo'), 'commit', '-qm', 'init');
    sh(join(reposRoot, 'demo'), 'push', '-q', 'origin', 'HEAD:main');
    sh(join(reposRoot, 'demo'), 'fetch', '-q', 'origin');
    sh(join(reposRoot, 'demo'), 'remote', 'set-head', 'origin', 'main');
    server = createApp({
      dataDir: data, token, reposRoot, reviewer,
      claude: createClaude({ command: process.execPath, prefixArgs: [fake] }),
      runner: { dayLimit: 5, nightLimit: 5, now: () => new Date(2026, 9, 13, 12, 0), tickMs: 3600_000 },
    });
    runner = server.runner;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    reviewer.calls.length = 0;
    reviewer.impl = async () => ({ summary: 'Looks fine.', findings: [], cost: 0.5 });
    for (const c of (await call('GET', '/api/cards')).body) await server.store.update(c.id, { status: 'archive' });
  });

  test('a clean review moves the card to review', async () => {
    const { card, run } = await finishedRun();
    await runner.tick();
    assert.equal(getRun(card.id).state, 'reviewing');
    assert.equal((await getCard(card.id)).status, 'running', 'still counts as running while it is being reviewed');
    await runner.settled();
    assert.equal((await getCard(card.id)).status, 'review');
    const r = getRun(card.id);
    assert.equal(r.state, 'finished');
    assert.equal(r.review.state, 'done');
    assert.deepEqual(r.review.findings, []);
    assert.equal(r.review.cost, 0.5);
    assert.match(readFileSync(cardFile(card.id, 'review.md'), 'utf8'), /No findings/);
    assert.equal(reviewer.calls.length, 1);
    assert.equal(reviewer.calls[0].base, 'origin/main');
    assert.ok(reviewer.calls[0].cwd.endsWith(join(card.id, 'demo')));
    assert.ok(calls().some((c) => c.args[0] === 'stop' && c.args[1] === run.agentId));
  });

  test('findings are sent back to the agent once; the second finish goes to review without another review', async () => {
    reviewer.impl = async () => ({ summary: 'One real bug.', findings: [FINDING], cost: 0.8 });
    const { card, run } = await finishedRun();
    await runner.tick();
    await runner.settled();

    assert.equal((await getCard(card.id)).status, 'running', 'the agent is fixing');
    const r = getRun(card.id);
    assert.equal(r.state, 'running');
    assert.equal(r.review.round, 1);
    assert.equal(r.agentId, run.agentId, 'same session, woken without flags');
    const wake = calls().findLast((c) => c.args.includes('--resume'));
    assert.equal(wake.args.length, 4);
    assert.match(wake.args[3], /code review found possible problems/);
    const reply = readFileSync(join(data, 'cards', card.id, 'replies', '1.md'), 'utf8');
    assert.match(reply, /1\. \[high\] demo: price\.js:7: discount divides by 10/);
    assert.match(reply, /What goes wrong: discounted\(100, 10\) returns 0/);
    assert.match(reply, /only fix round/);
    assert.ok(!existsSync(cardFile(card.id, 'report.md')), 'the old report was moved aside');

    // the agent finishes its fix round
    writeFileSync(cardFile(card.id, 'report.md'), GOOD_REPORT);
    setJob(run.agentId, { status: 'idle', state: 'done' });
    await runner.tick();
    await runner.settled();
    assert.equal((await getCard(card.id)).status, 'review');
    assert.equal(reviewer.calls.length, 1, 'no second review');
    assert.equal(getRun(card.id).review.findings.length, 1, 'the findings stay on record');
  });

  test('only low findings do not start a fix round and stay on record', async () => {
    reviewer.impl = async () => ({ summary: 'Nits.', findings: [{ ...FINDING, severity: 'low', summary: 'dead setting' }], cost: 0 });
    const { card } = await finishedRun();
    await runner.tick();
    await runner.settled();
    assert.equal((await getCard(card.id)).status, 'review');
    const r = getRun(card.id);
    assert.equal(r.review.round, 0);
    assert.equal(r.review.findings.length, 1);
    assert.match(readFileSync(cardFile(card.id, 'review.md'), 'utf8'), /dead setting/);
  });

  test('a mix of findings sends only the non-low ones to the agent', async () => {
    reviewer.impl = async () => ({ summary: 's', findings: [{ ...FINDING, severity: 'low', summary: 'dead setting' }, FINDING], cost: 0 });
    const { card } = await finishedRun();
    await runner.tick();
    await runner.settled();
    const reply = readFileSync(join(data, 'cards', card.id, 'replies', '1.md'), 'utf8');
    assert.match(reply, /discount divides by 10/);
    assert.doesNotMatch(reply, /dead setting/);
  });

  test('a report without a Verification section goes back to the agent as a finding', async () => {
    const { card } = await finishedRun('# Done\n\nAll good.\n');
    await runner.tick();
    await runner.settled();
    const r = getRun(card.id);
    assert.equal(r.state, 'running', 'the agent is asked to account for its testing');
    assert.deepEqual(r.review.findings.map((f) => f.source), ['verification']);
    assert.match(readFileSync(join(data, 'cards', card.id, 'replies', '1.md'), 'utf8'), /no "## Verification" section/);
  });

  test('a failing review does not block the card', async () => {
    reviewer.impl = async () => { throw new Error('claude exploded'); };
    const { card } = await finishedRun();
    await runner.tick();
    await runner.settled();
    assert.equal((await getCard(card.id)).status, 'review');
    const r = getRun(card.id);
    assert.equal(r.review.state, 'failed');
    assert.match(r.review.error, /claude exploded/);
    assert.match(readFileSync(cardFile(card.id, 'review.md'), 'utf8'), /review itself failed/);
  });

  test('if the findings cannot be delivered, the card still goes to review with a note', async () => {
    reviewer.impl = async () => ({ summary: 's', findings: [FINDING], cost: 0 });
    const { card, run } = await finishedRun();
    writeFileSync(join(state, 'jobs.json'), JSON.stringify(jobs().filter((j) => j.id !== run.agentId))); // the session vanished
    await runner.tick();
    await runner.settled();
    assert.equal((await getCard(card.id)).status, 'review');
    const r = getRun(card.id);
    assert.equal(r.review.round, 0);
    assert.match(r.review.error, /Could not send the findings/);
  });

  test('a review cut off by a restart is started again', async () => {
    const { card, run } = await finishedRun();
    await runner.tick();
    await runner.settled();
    // simulate: state was left as reviewing
    const stuck = getRun(card.id);
    stuck.state = 'reviewing';
    stuck.review = undefined;
    writeFileSync(cardFile(card.id, 'run.json'), JSON.stringify(stuck));
    await server.store.update(card.id, { status: 'running' });
    reviewer.calls.length = 0;
    await runner.tick();
    await runner.settled();
    assert.equal(reviewer.calls.length, 1);
    assert.equal((await getCard(card.id)).status, 'review');
    assert.ok(run.agentId);
  });
});

describe('reviewer', () => {
  let dir, script, log;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcontrol-reviewer-'));
    log = join(dir, 'calls.log');
    script = join(dir, 'claude-review.js');
    writeFileSync(script, `
      const { appendFileSync } = require('node:fs');
      let prompt = '';
      process.stdin.on('data', (d) => (prompt += d));
      process.stdin.on('end', () => {
        appendFileSync(process.env.REVIEW_LOG, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }) + '\\n');
        const bad = prompt.includes('BROKEN');
        if (prompt.startsWith('/code-review') && prompt.includes('PROSE')) {
          console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'I found 1 issue. '.repeat(20) + '1. price.js:7: bug' + (prompt.includes('UNCONVERTIBLE') ? ' UNCONVERTIBLE' : ''), total_cost_usd: 0.25 }));
          return;
        }
        if (prompt.startsWith('Convert the code review')) {
          const ok = !prompt.includes('UNCONVERTIBLE');
          console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.05, structured_output: ok ? { summary: 'from prose', findings: [{ file: 'price.js', line: 7, summary: 'bug', failure_scenario: 'wrong' }] } : undefined }));
          return;
        }
        const structured_output = prompt.startsWith('/security-review')
          ? { summary: 'sec ok', findings: [{ file: 'auth.js', summary: 'token logged', failure_scenario: 'log leak', severity: 'medium' }] }
          : { summary: 'code ok', findings: [{ file: 'price.js', line: 7, summary: 'bug', failure_scenario: 'wrong', severity: 'high' }] };
        console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: bad, result: 'boom', total_cost_usd: 0.25, structured_output: bad ? undefined : structured_output }));
      });
    `.replace(/^\s+/gm, ''));
    process.env.REVIEW_LOG = log;
  });
  after(() => rm(dir, { recursive: true, force: true }));
  const claudeFor = () => createClaude({ command: process.execPath, prefixArgs: [script] });
  const logged = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);

  test('runs /code-review against the base with a findings schema, read-only', async () => {
    const reviewer = createReviewer({ claude: claudeFor(), level: 'high', model: 'sonnet' });
    const r = await reviewer.review({ cwd: dir, base: 'origin/main' });
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].source, 'code-review');
    assert.equal(r.cost, 0.25);
    const call = logged().at(-1);
    assert.equal(call.prompt, '/code-review high origin/main...HEAD');
    assert.ok(call.args.includes('--json-schema'));
    assert.deepEqual(call.args.slice(call.args.indexOf('--disallowedTools'), call.args.indexOf('--disallowedTools') + 4), ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit']);
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet');
    assert.ok(!call.args.includes('--permission-mode'), 'plan mode writes plan files; read-only is enforced by the tool lists');
  });

  test('reviews only the commits since the branch met its base, never the base branch itself', async () => {
    await createReviewer({ claude: claudeFor(), security: true }).review({ cwd: dir, base: 'origin/angular-22', since: 'abc1234' });
    const [code, sec] = logged().slice(-2);
    assert.equal(code.prompt, '/code-review medium abc1234..HEAD');
    for (const call of [code, sec]) {
      const system = call.args[call.args.indexOf('--append-system-prompt') + 1];
      assert.match(system, /git diff abc1234\.\.HEAD/);
      assert.match(system, /already in origin\/angular-22/);
    }
  });

  test('adds a security review when asked and tags where each finding came from', async () => {
    const r = await createReviewer({ claude: claudeFor(), security: true }).review({ cwd: dir, base: 'origin/main' });
    assert.deepEqual(r.findings.map((f) => f.source), ['code-review', 'security-review']);
    assert.equal(r.cost, 0.5);
    assert.match(r.summary, /Security: sec ok/);
    assert.equal(logged().at(-1).prompt, '/security-review');
  });

  test('findings written as prose are converted instead of failing the review', async () => {
    const r = await createReviewer({ claude: claudeFor() }).review({ cwd: dir, base: 'PROSE' });
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].file, 'price.js');
    assert.equal(r.summary, 'from prose');
    assert.equal(Math.round(r.cost * 100), 30);
    const call = logged().at(-1);
    assert.match(call.prompt, /^Convert the code review/);
    assert.ok(!call.args.includes('--allowedTools'));
  });

  test('prose that cannot be converted still raises an error', async () => {
    await assert.rejects(createReviewer({ claude: claudeFor() }).review({ cwd: dir, base: 'PROSE UNCONVERTIBLE' }), /I found 1 issue/);
  });

  test('a failed review call raises an error', async () => {
    await assert.rejects(createReviewer({ claude: claudeFor() }).review({ cwd: dir, base: 'BROKEN' }), /boom/);
  });
});

describe('formatting', () => {
  test('fixRequest lists findings with location and failure scenario', () => {
    const text = fixRequest([{ repo: 'api', ...FINDING }, { file: 'x.js', summary: 'minor', failure_scenario: 'meh' }]);
    assert.match(text, /1\. \[high\] api: price\.js:7: discount divides by 10\n {3}What goes wrong: discounted/);
    assert.match(text, /2\. \[unrated\] x\.js: minor/);
  });
  test('reviewMarkdown covers findings, none and failure', () => {
    assert.match(reviewMarkdown({ summary: 's', findings: [FINDING] }), /## 1\. \[high\] price\.js:7: discount divides by 10/);
    assert.match(reviewMarkdown({ summary: 's', findings: [] }), /No findings/);
    assert.match(reviewMarkdown({ summary: '', findings: [], error: 'x' }), /review itself failed:\*\* x/);
  });
});

describe('verificationFinding', () => {
  test('accepts tested and justified skips', () => {
    assert.equal(verificationFinding(GOOD_REPORT), null);
  });
  test('rejects a missing, thin or reasonless section', () => {
    assert.match(verificationFinding('# Done').summary, /no "## Verification"/);
    assert.match(verificationFinding('## Verification\nok\n').summary, /empty or too thin/);
    assert.match(verificationFinding('## Verification\n- Tested: unit tests only, they all pass\n- **Skipped:** not needed\n').summary, /without a concrete reason/);
  });
  test('only reads up to the next heading', () => {
    assert.match(verificationFinding('## Verification\n\n## Risks\n- something long enough to pass the length check\n').summary, /empty or too thin/);
  });
});

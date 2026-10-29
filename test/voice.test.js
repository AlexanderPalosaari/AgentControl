import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { createClaude } from '../lib/claude.js';
import { ACTIONS, availableActions, createWakeGate, describe as describeAction, interpret, isApproval, isCancel, isDictationEnd, ownerFrom, sourceFrom, stripWakeWord, toProjectName } from '../public/voice.js';

const cards = [
  { id: 'c-1', title: 'Korjaa laskun pyöristys', status: 'inbox' },
  { id: 'c-2', title: 'Bugi kirjautumisessa', status: 'refining' },
];
const main = { state: 'main', cards, dispatcher: { enabled: true } };
const dialog = { state: 'dialog', cards, dispatcher: { enabled: true } };
const detail = (buttons = [], extra = {}) => ({ state: 'detail', cards, dispatcher: { enabled: true }, buttons, hasAnswerBox: false, ...extra });

// Every action should be reachable by several natural phrasings, not one exact sentence.
const corpus = (ctx, expected, phrases) => {
  for (const p of phrases) {
    test(`"${p}" -> ${expected.action}`, () => assert.deepEqual(interpret(p, ctx), expected));
  }
};

describe('global commands', () => {
  corpus(main, { action: 'new_card' }, ['lisää kortti', 'Lisää uusi kortti.', 'tee uusi kortti', 'haluan luoda uuden kortin', 'perusta kortti', 'ole hyvä ja luo uusi kortti']);
  corpus(main, { action: 'refresh' }, ['päivitä', 'virkistä', 'lataa uudelleen']);
  corpus(main, { action: 'pause_dispatch' }, ['tauota', 'tauota ajo', 'pysäytä ajo', 'keskeytä agentit', 'lopeta dispatcher']);
  corpus(main, { action: 'help' }, ['komennot', 'apua', 'mitä voin sanoa', 'näytä ohjeet']);
  corpus(main, { action: 'stop_listening' }, ['lopeta kuuntelu', 'puheohjaus pois', 'sammuta mikrofoni']);
  corpus(main, { action: 'quiet' }, ['hiljaa', 'vaikene']);
  corpus({ ...main, dispatcher: { enabled: false } }, { action: 'resume_dispatch' }, ['jatka ajoa', 'käynnistä agentit', 'aloita ajo']);
  corpus(main, { action: 'open_card', id: 'c-2', title: 'Bugi kirjautumisessa' }, ['avaa kortti bugi', 'avaa bugi kirjautumisessa', 'näytä kortti kirjautumisessa', 'siirry bugi']);

  test('pausing only matches when the dispatcher runs; resuming only when it is paused', () => {
    assert.equal(interpret('tauota', { ...main, dispatcher: { enabled: false } }), null);
    assert.equal(interpret('jatka ajoa', main), null);
    assert.equal(interpret('tauota', { state: 'main', cards }), null, 'dispatcher state unknown');
  });
  test('opening an unknown card falls through to the LLM', () => assert.equal(interpret('avaa kortti zzz', main), null));
  test('"avaa uusi kortti" opens the dialog, it does not search for a card', () => assert.deepEqual(interpret('avaa uusi kortti', main), { action: 'new_card' }));
  test('Finnish letters work at word edges', () => assert.deepEqual(interpret('päivitä', main), { action: 'refresh' }));
  test('empty or filler-only speech is ignored', () => {
    assert.equal(interpret('', main), null);
    assert.equal(interpret('okei kiitos', main), null);
  });
  test('close only exists when something is open', () => {
    assert.equal(interpret('sulje', main), null);
    assert.deepEqual(interpret('sulje', dialog), { action: 'close' });
    assert.deepEqual(interpret('peruuta', detail()), { action: 'close' });
  });
});

describe('new-card dialog', () => {
  corpus(dialog, { action: 'submit' }, ['luo', 'luo kortti', 'tallenna', 'valmis', 'hyväksy']);
  corpus(dialog, { action: 'set_title', text: 'korjaa bugi' }, ['otsikko korjaa bugi', 'otsikko on korjaa bugi', 'aseta otsikko korjaa bugi']);
  corpus(dialog, { action: 'append_brief', text: 'tee se nopeasti' }, ['kuvaus tee se nopeasti', 'kirjoita kuvaus tee se nopeasti']);
  corpus(dialog, { action: 'set_repos', names: ['repo-a', 'repo-b'] }, ['repo repo-a ja repo-b', 'repot repo-a, repo-b', 'repo repo-a repo-b']);
  corpus(dialog, { action: 'set_priority', value: 'high' }, ['prioriteetti korkea', 'tämä on tärkeä', 'prioriteetti kiireellinen']);
  corpus(dialog, { action: 'set_priority', value: 'low' }, ['prioriteetti matala', 'prioriteetti ei kiire']);
  corpus(dialog, { action: 'set_priority', value: 'normal' }, ['prioriteetti normaali']);
  test('"lisää kortti" in the open dialog is a no-op with an explanation', () => {
    assert.deepEqual(interpret('lisää uusi kortti', dialog), { action: 'noop', label: 'kortti-ikkuna on jo auki' });
  });
  test('dialog commands do not leak onto the board', () => assert.equal(interpret('otsikko korjaa bugi', main), null));
});

describe('card detail', () => {
  const all = ['Aloita tarkennus', 'Lähetä vastaukset', 'Start work', 'Lähetä vastaus', 'Pysäytä', 'Yritä uudelleen', 'Luo pull request'];
  corpus(detail(all), { action: 'start_refine' }, ['aloita tarkennus', 'käynnistä tarkennus', 'tee tarkennus']);
  corpus(detail(all), { action: 'send_answers' }, ['lähetä vastaukset']);
  corpus(detail(all), { action: 'start_work' }, ['aloita työ', 'aloita toteutus', 'laita työ käyntiin', 'start work']);
  corpus(detail(all), { action: 'send_answer' }, ['lähetä vastaus', 'lähetä']);
  corpus(detail(all), { action: 'stop' }, ['pysäytä', 'lopeta', 'keskeytä', 'seis']);
  corpus(detail(all), { action: 'retry' }, ['yritä uudelleen', 'kokeile uudestaan', 'jatka']);
  corpus(detail(all), { action: 'create_pr' }, ['luo pull request', 'tee pr', 'luo pull-request']);
  corpus(detail(all), { action: 'read_question' }, ['lue kysymys', 'kerro kysymykset', 'toista kysymys', 'mitä agentti kysyy']);
  corpus(detail(all, { hasAnswerBox: true }), { action: 'set_answer', text: 'käytä Postgresia' }, ['vastaa käytä Postgresia', 'vastaus käytä Postgresia']);

  corpus(detail([...all, 'Hyväksy työ projektiin']), { action: 'merge_local' }, ['hyväksy työ projektiin', 'hyväksy työ', 'yhdistä muutokset mainiin']);
  test('accepting work needs its button on screen, and does not start work', () => {
    assert.equal(interpret('hyväksy työ projektiin', detail(all)), null);
    assert.deepEqual(interpret('aloita työ', detail([...all, 'Hyväksy työ projektiin'])), { action: 'start_work' });
  });

  test('buttons that are not on screen are not matched', () => {
    assert.equal(interpret('aloita tarkennus', detail([])), null);
    assert.equal(interpret('pysäytä', detail(['Sulje'])), null);
  });
  test('"vastaa ..." needs an answer box', () => assert.equal(interpret('vastaa käytä Postgresia', detail(all, { hasAnswerBox: false })), null));
  test('"pysäytä ajo" pauses the dispatcher instead of stopping the agent', () => assert.deepEqual(interpret('pysäytä ajo', detail(all)), { action: 'pause_dispatch' }));
  test('"lopeta kuuntelu" turns voice off instead of stopping the agent', () => assert.deepEqual(interpret('lopeta kuuntelu', detail(all)), { action: 'stop_listening' }));
});

describe('projects and moving cards', () => {
  const projects = [{ name: 'rs3ai', step: 'describe' }, { name: 'tilausportaali', step: 'done' }];
  const board = { ...main, projects };
  const project = (step, local = true) => ({ state: 'project', cards, dispatcher: { enabled: true }, projects, project: { name: 'rs3ai', step, local } });

  corpus(board, { action: 'new_project', name: 'rs3ai' }, ['perusta uus projekti nimeltä rs3ai', 'luo uusi projekti rs3ai', 'tee projekti nimeltään rs3ai', 'uusi projekti, nimi on rs3ai']);
  corpus(board, { action: 'new_project', name: 'rs3ai', source: 'github' }, ['perusta uusi projekti githubiin nimeltä rs3ai', 'uusi projekti rs3ai githubiin']);
  corpus(board, { action: 'new_project', name: 'rs3ai', source: 'local' }, ['perusta projekti rs3ai paikallisesti', 'uusi projekti nimeltä rs3ai paikallinen repo']);
  corpus(board, { action: 'new_project' }, ['perusta uusi projekti', 'haluan aloittaa uuden projektin']);
  corpus(board, { action: 'new_project', name: 'porssi', source: 'github', owner: 'acme' }, ['perusta projekti nimeltä pörssi githubiin organisaatioon acme']);
  corpus(board, { action: 'open_project', name: 'rs3ai' }, ['avaa projekti rs3ai', 'näytä projekti RS3AI']);
  corpus({ ...board, projects: [...projects, { name: 'Taalla-on-yksi-puolesta', step: 'describe' }] }, { action: 'delete_project', name: 'Taalla-on-yksi-puolesta' },
    ['poista taalla on yksi puolesta', 'poista projekti Täällä on yksi puolesta', 'tuhoa projekti taalla-on-yksi-puolesta']);
  corpus(project('review'), { action: 'delete_project', name: 'rs3ai' }, ['poista projekti', 'poista tämä projekti']);
  test('"poista" only deletes a project that is on the list', () => {
    assert.equal(interpret('poista kuva', board), null);
    assert.equal(interpret('poista projekti zzz', board), null);
    assert.equal(interpret('poista projekti', board), null, 'no project open: which one?');
  });
  corpus(board, { action: 'move_card', id: 'c-2', title: 'Bugi kirjautumisessa', status: 'archive' }, ['arkistoi kortti bugi', 'arkistoi bugi kirjautumisessa', 'siirrä bugi arkistoon']);
  corpus(board, { action: 'move_card', id: 'c-1', title: 'Korjaa laskun pyöristys', status: 'done' }, ['merkitse laskun pyöristys valmiiksi', 'siirrä kortti pyöristys doneen']);
  corpus(board, { action: 'move_card', id: 'c-1', title: 'Korjaa laskun pyöristys', status: 'inbox' }, ['palauta pyöristys inboxiin']);

  corpus(project('describe'), { action: 'describe_project', text: 'Tekoäly, joka pelaa RuneScape 3:a' }, ['kuvaus: Tekoäly, joka pelaa RuneScape 3:a', 'kuvaile Tekoäly, joka pelaa RuneScape 3:a']);
  corpus(project('review'), { action: 'create_tasks' }, ['luo kortit', 'tee kortit', 'hyväksy suunnitelma']);
  corpus(project('review'), { action: 'plan_feedback', text: 'käytä Rustia' }, ['muutos: käytä Rustia', 'muuta käytä Rustia']);
  corpus(project('describe'), { action: 'publish_github' }, ['vie githubiin', 'julkaise projekti GitHubiin']);
  corpus(project('remote', false), { action: 'retry_github' }, ['yritä uudelleen']);
  corpus(project('remote', false), { action: 'keep_local' }, ['jatka paikallisena']);
  corpus(project('review'), { action: 'close' }, ['sulje']);

  test('project commands only work at the matching step', () => {
    assert.equal(interpret('luo kortit', project('describe')), null);
    assert.equal(interpret('kuvaus: x', project('review')), null);
    assert.equal(interpret('vie githubiin', project('describe', false)), null, 'already on GitHub');
    assert.equal(interpret('vie githubiin', project('planning')), null);
  });
  test('board commands do not run inside the project dialog', () => {
    assert.equal(interpret('lisää kortti', project('review')), null);
    assert.equal(interpret('avaa kortti bugi', project('review')), null);
  });
  test('moving needs a known card and a column', () => {
    assert.equal(interpret('arkistoi zzz', board), null);
    assert.equal(interpret('siirrä bugi', board), null, 'no column');
  });
  test('names, places and answers in follow-ups', () => {
    assert.equal(toProjectName(' "Tilauspörssi 2". '), 'Tilausporssi-2');
    assert.equal(toProjectName('-x'), 'x');
    assert.equal(sourceFrom('GitHubiin kiitos'), 'github');
    assert.equal(sourceFrom('paikallisesti'), 'local');
    assert.equal(sourceFrom('en tiedä'), undefined);
    assert.equal(ownerFrom('organisaatioon acme-oy'), 'acme-oy');
    for (const yes of ['ok', 'Kyllä.', 'luo kortit', 'Hyväksyn', 'näyttää hyvältä']) assert.ok(isApproval(yes), yes);
    for (const no of ['käytä Rustia', 'lisää tehtävä testeille', 'ei']) assert.ok(!isApproval(no), no);
    assert.ok(isCancel('Peruuta.'));
    assert.ok(!isCancel('peruutusehto pitää olla'));
  });
});

describe('describe / availableActions', () => {
  test('describes actions in Finnish for the status line', () => {
    assert.equal(describeAction({ action: 'set_priority', value: 'high' }), 'prioriteetti high');
    assert.equal(describeAction({ action: 'open_card', id: 'c-1', title: 'X' }), 'kortti: X');
  });
  test('availability follows the screen and the buttons', () => {
    assert.ok(availableActions(main).includes('new_card'));
    assert.ok(!availableActions(main).includes('submit'));
    assert.ok(availableActions(dialog).includes('submit'));
    assert.ok(availableActions(detail(['Pysäytä'])).includes('stop'));
    assert.ok(!availableActions(detail(['Pysäytä'])).includes('start_work'));
    assert.ok(!availableActions({ ...main, dispatcher: { enabled: false } }).includes('pause_dispatch'));
  });
  test('every action the rules can produce exists in the vocabulary the LLM is given', () => {
    const produced = new Set();
    for (const [ctx, phrases] of [
      [main, ['lisää kortti', 'päivitä', 'komennot', 'tauota', 'avaa bugi', 'hiljaa', 'lopeta kuuntelu']],
      [dialog, ['luo', 'otsikko x', 'kuvaus x', 'repo x', 'prioriteetti korkea', 'sulje']],
      [{ ...detail(), buttons: undefined }, ['aloita tarkennus', 'lähetä vastaukset', 'aloita työ', 'lähetä vastaus', 'pysäytä', 'yritä uudelleen', 'luo pr', 'lue kysymys']],
      [detail([], { hasAnswerBox: true }), ['vastaa x']],
    ]) for (const p of phrases) produced.add(interpret(p, ctx)?.action);
    produced.delete('noop');
    for (const name of produced) assert.ok(name in ACTIONS, name);
    assert.ok(produced.size >= 20, `only ${produced.size} actions produced`);
  });
});

describe('wake word', () => {
  test('strips the wake word and the punctuation after it', () => {
    assert.deepEqual(stripWakeWord('Agentti, lisää kortti'), { woke: true, rest: 'lisää kortti' });
    assert.deepEqual(stripWakeWord('hei agentti lisää kortti'), { woke: true, rest: 'lisää kortti' });
    assert.deepEqual(stripWakeWord('agentti'), { woke: true, rest: '' });
    assert.deepEqual(stripWakeWord('agentit: päivitä'), { woke: true, rest: 'päivitä' });
  });
  test('only a whole leading word counts', () => {
    assert.equal(stripWakeWord('agenttiä ei saa pysäyttää').woke, false);
    assert.equal(stripWakeWord('lisää kortti agentti').woke, false);
    assert.equal(stripWakeWord('lisää kortti').woke, false);
  });

  test('the gate ignores speech until woken, then stays open for the window, then closes', () => {
    let t = 1000;
    const gate = createWakeGate({ windowMs: 10_000, now: () => t });
    assert.equal(gate.accept('lisää kortti'), null);
    assert.equal(gate.isOpen(), false);

    assert.equal(gate.accept('agentti, lisää kortti'), 'lisää kortti');
    assert.equal(gate.isOpen(), true);

    t += 8000;
    assert.equal(gate.accept('otsikko korjaa bugi'), 'otsikko korjaa bugi', 'follow-up without the wake word');
    t += 8000;
    assert.equal(gate.accept('kuvaus jotain'), 'kuvaus jotain', 'each accepted command extends the window');
    t += 10_001;
    assert.equal(gate.accept('puhetta taustalla'), null);
  });
  test('a bare wake word opens the gate and returns an empty command', () => {
    const gate = createWakeGate({ now: () => 0 });
    assert.equal(gate.accept('agentti'), '');
    assert.equal(gate.isOpen(), true);
  });
  test('peek does not open the gate', () => {
    const gate = createWakeGate({ now: () => 0 });
    assert.equal(gate.peek('agentti lisää'), true);
    assert.equal(gate.peek('lisää'), false);
    assert.equal(gate.isOpen(), false);
  });
});

describe('fuzzy matching and dictation', () => {
  test('wake word survives common mishearings but not other words', () => {
    for (const w of ['agenti', 'ajentti', 'Agentit', 'ajenti']) assert.equal(stripWakeWord(`${w} päivitä`).woke, true, w);
    for (const w of ['agenttiä', 'agentille', 'agentteja', 'kentti']) assert.equal(stripWakeWord(`${w} päivitä`).woke, false, w);
  });
  test('open_card tolerates other inflections and slight mishearings', () => {
    assert.deepEqual(interpret('avaa kortti kirjautuminen', main), { action: 'open_card', id: 'c-2', title: 'Bugi kirjautumisessa' });
    assert.deepEqual(interpret('avaa kortti pyöristys', main)?.id, 'c-1');
    assert.equal(interpret('avaa kortti zzzzz', main), null);
  });
  test('ambiguous fuzzy matches fall through to the LLM', () => {
    const two = { ...main, cards: [{ id: 'a', title: 'Korjaa kirjautuminen' }, { id: 'b', title: 'Kirjautumisen testit' }] };
    assert.equal(interpret('avaa kortti kirjautumisessa', two), null);
  });
  corpus(dialog, { action: 'dictate_brief' }, ['sanele kuvaus', 'kuvaus', 'kirjoita kuvaus', 'dikteeraa kuvaus']);
  corpus(detail([], { hasAnswerBox: true }), { action: 'dictate_answer' }, ['sanele vastaus', 'kirjoita vastaus']);
  test('dictating an answer needs the answer box', () => assert.equal(interpret('sanele vastaus', detail([], { hasAnswerBox: false })), null));
  test('dictation ends with "valmis" and friends', () => {
    for (const p of ['valmis', 'Valmis.', 'sanelu valmis', 'lopeta sanelu', 'se oli kaikki']) assert.equal(isDictationEnd(p), true, p);
    for (const p of ['valmis kuvaus', 'tee se valmiiksi', '']) assert.equal(isDictationEnd(p), false, p);
  });
});

describe('POST /api/voice/interpret', () => {
  const fake = fileURLToPath(new URL('./fake-voice-claude.js', import.meta.url));
  const headers = { Cookie: 'ac_token=t', 'Content-Type': 'application/json' };
  let dir, logFile, server, base;
  const ask = async (text, context = { state: 'main', cards, repos: ['repo-a', 'repo-b'] }) => {
    const res = await fetch(`${base}/api/voice/interpret`, { method: 'POST', headers, body: JSON.stringify({ text, context }) });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcontrol-voice-'));
    logFile = join(dir, 'fake.log');
    process.env.FAKE_LOG = logFile;
    server = createApp({ dataDir: join(dir, 'data'), token: 't', reposRoot: dir, claude: createClaude({ command: process.execPath, prefixArgs: [fake] }) });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  test('runs claude with no tools, no session, a schema and the small model', async () => {
    await ask('hmm');
    const call = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    assert.ok(call.args.includes('--no-session-persistence'));
    assert.ok(call.args.includes('--strict-mcp-config'));
    assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '', 'user hooks and plugins are not loaded');
    assert.ok(call.args.includes('--json-schema'));
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'haiku');
    assert.match(call.prompt, /Transcript: "hmm"/);
    assert.match(call.prompt, /c-2 \| Bugi kirjautumisessa \| refining/);
    assert.match(call.prompt, /- new_card:/);
    assert.doesNotMatch(call.prompt, /- submit:/, 'dialog actions are not offered on the board');
  });

  test('returns an allowed action with its fields', async () => {
    const r = await ask('avaa se bugikortti');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { action: 'open_card', id: 'c-2', title: 'Bugi kirjautumisessa', say: '' });
  });
  test('a card id the model made up becomes "none"', async () => {
    assert.equal((await ask('oikeasti toinen kortti')).body.action, 'none');
  });
  test('an action outside the vocabulary becomes "none"', async () => {
    assert.equal((await ask('jotain outoa')).body.action, 'none');
  });
  test('an action that is not available on this screen becomes "none"', async () => {
    const r = await ask('kirjoita otsikoksi korjaa kirjautuminen');
    assert.equal(r.body.action, 'none', 'set_title only exists in the new-card dialog');
    const ok = await ask('kirjoita otsikoksi korjaa kirjautuminen', { state: 'dialog', cards });
    assert.deepEqual(ok.body, { action: 'set_title', text: 'Korjaa kirjautuminen', say: '' });
  });
  test('an invalid priority becomes "none"', async () => {
    assert.equal((await ask('prioriteetti mahtava', { state: 'dialog', cards })).body.action, 'none');
  });
  test('repo names are matched to the known repos and bad ones dropped', async () => {
    const r = await ask('repot', { state: 'dialog', cards, repos: ['repo-a', 'repo-b'] });
    assert.deepEqual(r.body.names, ['repo-a']);
  });
  test('detail buttons must be on screen', async () => {
    assert.equal((await ask('lopeta tehtävä', { state: 'detail', cards, buttons: ['Sulje'] })).body.action, 'none');
    assert.equal((await ask('lopeta tehtävä', { state: 'detail', cards, buttons: ['Pysäytä'] })).body.action, 'stop');
  });
  test('the model can ask for clarification', async () => {
    assert.deepEqual((await ask('blaa')).body, { action: 'none', say: 'Mitä tarkoitat?' });
  });
  test('logs sentences that needed the model, for turning into rules later', async () => {
    await ask('lokita tämä');
    const lines = (await readFile(join(dir, 'data', 'voice-fallbacks.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const last = lines.at(-1);
    assert.equal(last.text, 'lokita tämä');
    assert.equal(last.state, 'main');
    assert.equal(typeof last.ms, 'number');
  });
  test('rejects missing or oversized text', async () => {
    assert.equal((await ask('')).status, 400);
    assert.equal((await ask('x'.repeat(2001))).status, 400);
  });
  test('a new project gets a valid name, and a bad owner is dropped', async () => {
    assert.deepEqual((await ask('tee minulle projekti')).body, { action: 'new_project', name: 'Porssi-Botti', source: 'github', say: '' });
  });
  test('moving a card needs a real card and column', async () => {
    assert.deepEqual((await ask('arkistoi laskujuttu')).body, { action: 'move_card', id: 'c-1', title: 'Korjaa laskun pyöristys', status: 'archive', say: '' });
    assert.equal((await ask('siirrä se jonnekin')).body.action, 'none');
  });
  test('projects are offered to the model and matched by name', async () => {
    const context = { state: 'main', cards, projects: [{ name: 'rs3ai', step: 'describe', local: true }] };
    assert.deepEqual((await ask('avaa se peliprojekti', context)).body, { action: 'open_project', name: 'rs3ai', say: '' });
    const call = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
    assert.match(call.prompt, /Projects: rs3ai/);
    assert.equal((await ask('avaa se peliprojekti')).body.action, 'none', 'no projects: nothing to open');
  });
  test('project steps decide what the model may do in a project dialog', async () => {
    const at = (step) => ({ state: 'project', cards, projects: [{ name: 'rs3ai', step }], project: { name: 'rs3ai', step, local: true } });
    assert.deepEqual((await ask('se on peli-ai', at('describe'))).body, { action: 'describe_project', text: 'Peli-AI RuneScapeen', say: '' });
    assert.equal((await ask('se on peli-ai', at('review'))).body.action, 'none');
    const call = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
    assert.match(call.prompt, /the project "rs3ai" is open \(step: review\)/);
  });
  test('a failing claude gives a readable 502', async () => {
    const r = await ask('FAIL');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /tulkinta epäonnistui/);
  });
  test('requires the token', async () => {
    const res = await fetch(`${base}/api/voice/interpret`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });
  test('serves the shared module to the page', async () => {
    const res = await fetch(`${base}/voice.js`, { headers });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.match(await res.text(), /export function interpret/);
  });
});

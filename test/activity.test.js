import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createActivity, quitWarning } from '../lib/activity.js';

const none = () => [];

/** createActivity over stand-ins: `cards` with their run states, and what each module says it has in flight. */
function activityOf({ cards = [], runs = {}, busy = {}, queue = { enabled: true, order: [] } } = {}) {
  return createActivity({
    store: { list: async () => cards },
    runner: { run: async (id) => runs[id] ?? null, queue: async () => queue },
    refiner: { busy: () => busy.refiner ?? [] },
    projects: { busy: () => busy.projects ?? [] },
    explorer: { busy: () => busy.explorer ?? [] },
    auditor: { busy: none },
    orchestrator: { busy: () => busy.orchestrator ?? false },
    sandbox: { busy: () => busy.sandbox ?? [] },
    publisher: { busy: () => busy.publisher ?? [] },
  });
}

describe('activity', () => {
  test('lists running work with what stopping does to it', async () => {
    const cards = [
      { id: 'c-a', title: 'Agentti töissä', status: 'running' },
      { id: 'c-b', title: 'Katselmoidaan', status: 'running' },
      { id: 'c-c', title: 'Tarkennetaan', status: 'refining' },
      { id: 'c-d', title: 'Valmis', status: 'review' },
    ];
    const out = await activityOf({
      cards, runs: { 'c-a': { state: 'running' }, 'c-b': { state: 'reviewing' } },
      busy: { refiner: ['c-c'], projects: ['shop'], orchestrator: true, publisher: ['c-d'] },
      queue: { enabled: true, order: ['c-x', 'c-y'] },
    })();
    assert.deepEqual(out.items, [
      { what: 'Toteutus', title: 'Agentti töissä', onStop: 'continues' },
      { what: 'Katselmointi', title: 'Katselmoidaan', onStop: 'resumes' },
      { what: 'Tarkennus', title: 'Tarkennetaan', onStop: 'resumes' },
      { what: 'Projektin suunnittelu', title: 'shop', onStop: 'lost' },
      { what: 'Ohjaajan vastaus', title: '', onStop: 'lost' },
      { what: 'Pull request tai yhdistäminen', title: 'Valmis', onStop: 'lost' },
    ]);
    assert.equal(out.queued, 2);
  });

  test('a paused dispatcher has nothing queued, and a quiet board nothing at all', async () => {
    assert.deepEqual(await activityOf({ queue: { enabled: false, order: ['c-x'] } })(), { items: [], queued: 0 });
  });
});

describe('quit warning', () => {
  test('nothing running, nothing to warn about', () => {
    assert.equal(quitWarning({ items: [], queued: 0 }), null);
    assert.equal(quitWarning({}), null);
  });

  test('groups the work by what happens to it, the worst first', () => {
    const w = quitWarning({
      items: [
        { what: 'Toteutus', title: 'A', onStop: 'continues' },
        { what: 'Tarkennus', title: 'B', onStop: 'resumes' },
        { what: 'Projektin suunnittelu', title: 'shop', onStop: 'lost' },
      ],
      queued: 1,
    });
    assert.equal(w.message, '3 työtä on käynnissä. Lopetetaanko AgentControl silti?');
    const order = ['Keskeytyy', 'Alkaa alusta', 'Jatkuu taustalla', '1 kortti odottaa'].map((s) => w.detail.indexOf(s));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), w.detail);
    assert.match(w.detail, /• Projektin suunnittelu: shop/);
    assert.match(w.detail, /• Toteutus: A/);
  });

  test('queued cards alone still warn, since they will not start', () => {
    const w = quitWarning({ items: [], queued: 3 });
    assert.equal(w.message, 'Kortteja on jonossa. Lopetetaanko AgentControl silti?');
    assert.match(w.detail, /3 korttia odottaa vuoroaan/);
  });
});

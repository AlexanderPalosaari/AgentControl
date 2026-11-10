import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createCardStore } from '../lib/cards.js';
import { createJournal } from '../lib/events.js';
import { createDaySummary, localDay } from '../lib/summary.js';
import { createUsageLedger } from '../lib/usage.js';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'agentcontrol-summary-')); });
after(() => rm(dir, { recursive: true, force: true }));

test('a day\'s summary: what finished (with its commit message or report), what waits for review, what is under way', async () => {
  const journal = createJournal(join(dir, 'events.jsonl'));
  const log = (kind, text, extra = {}) => journal.add({ kind, text, ...extra });
  const store = createCardStore(dir, { log });
  const ledger = createUsageLedger(dir);

  const done = await store.create({ title: 'Haku', repos: ['app'] });
  for (const s of ['refining', 'ready', 'running', 'review', 'done']) await store.update(done.id, { status: s });
  writeFileSync(join(store.dir(done.id), 'commit-message.txt'), 'Add search to the order list\n\nDetails');
  const research = await store.create({ title: 'Maksupalvelut', kind: 'research' });
  for (const s of ['ready', 'running', 'review']) await store.update(research.id, { status: s });
  writeFileSync(join(store.dir(research.id), 'report.md'), '# Raportti\n\n## Vastaus\nPaytrail sopii parhaiten.\n');
  log('agent', 'Selvitys valmis: Maksupalvelut', { card: research.id });
  const working = await store.create({ title: 'Raportit' });
  await store.update(working.id, { status: 'refining' });
  log('refine', 'Tarkennus alkoi: Raportit', { card: working.id });
  log('merge', 'Työ yhdistetty projektiin: Haku (app@main abc1234)', { card: done.id });
  log('agent', 'Agentin käynnistys epäonnistui: X: boom', { level: 'error' });
  ledger.record('agent', { input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0 }, { card: done.id });

  const { summary } = createDaySummary({ journal, store, ledger });
  const s = await summary();
  assert.equal(s.day, localDay(Date.now()));
  assert.deepEqual(s.done.map((x) => [x.title, x.what]), [['Haku', 'Add search to the order list']]);
  assert.deepEqual(s.review.map((x) => [x.title, x.kind, x.what]), [['Maksupalvelut', 'research', 'Paytrail sopii parhaiten.']]);
  assert.deepEqual(s.inProgress.map((x) => [x.title, x.statusName]), [['Raportit', 'Refining']]);
  assert.equal(s.created.length, 3);
  assert.equal(s.counts.research, 1);
  assert.equal(s.counts.merged, 1);
  assert.equal(s.counts.errors, 1);
  assert.equal(s.tokens.input + s.tokens.output, 1500);
  assert.match(s.markdown, /## Valmistui\n- \*\*Haku\*\*: Add search to the order list/);
  assert.match(s.markdown, /\[Selvitys\] \*\*Maksupalvelut\*\*/);

  const quiet = await summary({ day: '2020-01-01' });
  assert.equal(quiet.quiet, true);
  assert.match(quiet.markdown, /ei ole tapahtumia/);
  await assert.rejects(summary({ day: 'eilen' }), /YYYY-MM-DD/);
});

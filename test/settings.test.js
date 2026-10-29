import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';

const headers = { Cookie: 'ac_token=t', 'Content-Type': 'application/json' };
let dir, data;
const open = async () => {
  const server = createApp({ dataDir: data, token: 't', reposRoot: dir, runner: { dayLimit: 4, nightLimit: 6, trust: async () => {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { server, call, close: () => new Promise((r) => server.close(r)) };
};

before(async () => { dir = await mkdtemp(join(tmpdir(), 'ac-settings-')); data = join(dir, 'data'); });
after(() => rm(dir, { recursive: true, force: true }));

describe('settings', () => {
  test('reports the startup limits, and saves changed ones for the next start', async () => {
    let app = await open();
    const first = await app.call('GET', '/api/settings');
    assert.deepEqual([first.body.runner.dayLimit, first.body.runner.nightLimit, first.body.runner.nightStart, first.body.runner.nightEnd], [4, 6, 22, 7]);

    const saved = await app.call('POST', '/api/settings', { dayLimit: 2, nightStart: 23 });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.runner.dayLimit, saved.body.runner.nightLimit, saved.body.runner.nightStart], [2, 6, 23]);
    assert.ok(existsSync(join(data, 'settings.json')));
    await app.close();

    app = await open(); // saved values win over the startup ones
    assert.deepEqual([(await app.call('GET', '/api/settings')).body.runner.dayLimit, JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).runner.nightStart], [2, 23]);
    await app.close();
  });

  test('rejects values that would stall or confuse the dispatcher, and keeps the old ones', async () => {
    const app = await open();
    for (const bad of [{ dayLimit: 0 }, { dayLimit: 1.5 }, { nightLimit: 21 }, { nightStart: 24 }, { nightStart: 7, nightEnd: 7 }, { dayLimit: '3' }]) {
      const res = await app.call('POST', '/api/settings', bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await app.call('GET', '/api/settings')).body.runner.dayLimit, 2);
    await app.close();
  });

  test('requires the token', async () => {
    const app = await open();
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/settings`);
    assert.equal(res.status, 401);
    await app.close();
  });
});

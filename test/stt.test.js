import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server.js';
import { decodeSamples } from '../lib/stt.js';
import { createSegmenter, plausible, resample } from '../public/mic.js';

const FRAME = 128;
const frames = (ms, amp) => Array.from({ length: Math.round((16 * ms) / FRAME) }, () => new Float32Array(FRAME).fill(amp));
const run = (seg, parts) => parts.flatMap((p) => p.flatMap((f) => seg.feed(f)));

describe('segmenter', () => {
  test('cuts one utterance after the silence that follows speech, keeping a little lead-in', () => {
    const seg = createSegmenter();
    const out = run(seg, [frames(500, 0.001), frames(1000, 0.2), frames(1000, 0.001)]);
    assert.equal(out.length, 1);
    const seconds = out[0].length / 16000;
    assert.ok(seconds > 1.6 && seconds < 2.4, `about 0.3 s lead-in + 1 s speech + 0.8 s hang, got ${seconds}`);
  });

  test('drops blips shorter than the minimum speech length', () => {
    const seg = createSegmenter();
    assert.equal(run(seg, [frames(500, 0.001), frames(100, 0.3), frames(1200, 0.001)]).length, 0);
  });

  test('a pause inside the hang time does not split the utterance', () => {
    const seg = createSegmenter();
    const out = run(seg, [frames(300, 0.001), frames(600, 0.2), frames(400, 0.001), frames(600, 0.2), frames(1000, 0.001)]);
    assert.equal(out.length, 1);
  });

  test('two separate utterances come out separately; very long speech is cut', () => {
    const seg = createSegmenter({ maxMs: 2000 });
    assert.equal(run(seg, [frames(1000, 0.2), frames(1000, 0.001), frames(1000, 0.2), frames(1000, 0.001)]).length, 2);
    assert.equal(run(createSegmenter({ maxMs: 2000 }), [frames(2500, 0.2)]).length, 1);
  });

  test('reset forgets a half-heard utterance (used while we are speaking ourselves)', () => {
    const seg = createSegmenter();
    run(seg, [frames(600, 0.2)]);
    seg.reset();
    assert.equal(run(seg, [frames(1200, 0.001)]).length, 0);
  });
});

describe('helpers', () => {
  test('resample changes the length by the rate ratio', () => {
    assert.equal(resample(new Float32Array(48000), 48000).length, 16000);
    assert.equal(resample(new Float32Array(16000), 16000).length, 16000);
  });
  test('plausible drops empty text and known Whisper inventions', () => {
    assert.equal(plausible('lisää kortti'), true);
    for (const t of ['', ' . ', '...', 'Tekstitys: Amara.org', 'Kiitos katsomisesta!']) assert.equal(plausible(t), false, t);
  });
  test('decodeSamples reads float32 and rejects bad bodies', () => {
    const buf = Buffer.alloc(8);
    buf.writeFloatLE(0.5, 0);
    buf.writeFloatLE(-0.25, 4);
    assert.deepEqual([...decodeSamples(buf)], [0.5, -0.25]);
    assert.throws(() => decodeSamples(Buffer.alloc(0)));
    assert.throws(() => decodeSamples(Buffer.alloc(7)));
    assert.throws(() => decodeSamples(Buffer.alloc(16000 * 31 * 4)), /longer than 30 seconds/);
  });
});

describe('POST /api/transcribe', () => {
  let dir, server, base, seen;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcontrol-stt-'));
    const stt = { transcribe: async (samples) => { seen = samples; return 'lisää kortti'; }, warm: async () => true };
    server = createApp({ dataDir: dir, token: 't', stt });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const post = (body, cookie = 'ac_token=t') => fetch(`${base}/api/transcribe`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body });

  test('transcribes raw float32 samples', async () => {
    const res = await post(new Float32Array([0.1, 0.2, 0.3]));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'lisää kortti' });
    assert.equal(seen.length, 3);
  });
  test('requires the token', async () => {
    assert.equal((await post(new Float32Array(4), 'ac_token=wrong')).status, 401);
  });
  test('rejects a body that is not float32 samples', async () => {
    assert.equal((await post(Buffer.alloc(5))).status, 400);
  });
});

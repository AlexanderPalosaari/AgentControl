import { Worker } from 'node:worker_threads';

/**
 * Local speech-to-text (Whisper via transformers.js). The model downloads once into <cacheDir> and everything
 * runs on this machine, in a worker thread so the HTTP server stays responsive while a clip is transcribed.
 * Clips are transcribed one at a time, in order (the worker queues them).
 */
export const SAMPLE_RATE = 16_000;
export const MAX_SECONDS = 30;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let asr = null;
function load() {
  asr ??= import(workerData.transformers).then(async ({ pipeline, env }) => {
    env.cacheDir = workerData.cacheDir;
    const pipe = await pipeline('automatic-speech-recognition', workerData.model, { dtype: 'q8' });
    await pipe(new Float32Array(16000), { language: workerData.language, task: 'transcribe' }); // the first run is twice as slow
    return pipe;
  }).catch((e) => { asr = null; throw e; });
  return asr;
}
let queue = Promise.resolve();
parentPort.on('message', ({ id, samples }) => {
  queue = queue.then(async () => {
    try {
      const pipe = await load();
      if (!samples) return parentPort.postMessage({ id, text: '' });
      const out = await pipe(samples, { language: workerData.language, task: 'transcribe' });
      parentPort.postMessage({ id, text: String(out.text ?? '').trim() });
    } catch (e) {
      parentPort.postMessage({ id, error: e.message });
    }
  });
});
`;

export function createStt({ cacheDir, model = 'Xenova/whisper-small', language = 'finnish' }) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();

  function ensureWorker() {
    if (worker) return worker;
    const transformers = import.meta.resolve('@huggingface/transformers'); // eval'd code cannot resolve packages itself
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { cacheDir, model, language, transformers } });
    worker.on('message', ({ id, text, error }) => {
      const p = pending.get(id);
      pending.delete(id);
      if (error) p?.reject(new Error(error)); else p?.resolve(text);
      if (!pending.size) worker?.unref(); // an idle model must not keep the process alive
    });
    worker.on('error', (e) => {
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      worker = null;
    });
    return worker;
  }

  function send(samples) {
    const w = ensureWorker();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.ref();
      w.postMessage({ id, samples }, samples ? [samples.buffer] : []);
    });
  }

  return {
    /** Mono 16 kHz samples in [-1, 1] → text ('' when nothing intelligible). The buffer is transferred. */
    transcribe: (samples) => send(samples),
    /** Loads the model ahead of the first clip; resolves true when it is ready. */
    warm: () => send(null).then(() => true, () => false),
    close: () => worker?.terminate(),
  };
}

/** Raw little-endian float32 body → Float32Array, or throws a message fit for a 400 response. */
export function decodeSamples(buf) {
  if (buf.length === 0 || buf.length % 4 !== 0) throw new Error('body must be raw float32 samples');
  if (buf.length > SAMPLE_RATE * MAX_SECONDS * 4) throw new Error(`audio is longer than ${MAX_SECONDS} seconds`);
  const samples = new Float32Array(buf.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
  return samples;
}

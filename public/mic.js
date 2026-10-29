// Microphone capture for local speech recognition. Cuts the audio into utterances (simple energy-based voice
// activity detection) and hands each one over as 16 kHz mono samples. The segmenter has no DOM access, so it
// runs under `node --test`; startMic() is the browser-only part.

export const TARGET_RATE = 16_000;

/** Feed fixed-size Float32Array frames; feed() returns the utterances that finished with this frame. */
export function createSegmenter({ rate = TARGET_RATE, minRms = 0.015, hangMs = 800, minSpeechMs = 400, preMs = 300, maxMs = 25_000 } = {}) {
  const hang = (rate * hangMs) / 1000;
  const minSpeech = (rate * minSpeechMs) / 1000;
  const pre = (rate * preMs) / 1000;
  const max = (rate * maxMs) / 1000;
  let floor = 0.005; // slow estimate of the background noise
  let speaking = false;
  let buf = [];
  let preroll = [];
  let preLen = 0;
  let silent = 0;
  let speech = 0;
  let total = 0;

  const rmsOf = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / (f.length || 1)); };
  const concat = (parts) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const reset = () => { speaking = false; buf = []; preroll = []; preLen = 0; silent = 0; speech = 0; total = 0; };

  return {
    get speaking() { return speaking; },
    reset,
    feed(frame) {
      const out = [];
      const rms = rmsOf(frame);
      const voiced = rms > Math.max(minRms, floor * 3);
      if (!speaking) {
        if (voiced) {
          speaking = true;
          buf = [...preroll, frame];
          total = preLen + frame.length;
          preroll = []; preLen = 0;
          speech = frame.length;
          silent = 0;
        } else {
          floor = floor * 0.98 + rms * 0.02;
          preroll.push(frame);
          preLen += frame.length;
          while (preroll.length > 1 && preLen - preroll[0].length >= pre) preLen -= preroll.shift().length;
        }
        return out;
      }
      buf.push(frame);
      total += frame.length;
      if (voiced) { speech += frame.length; silent = 0; } else silent += frame.length;
      if (silent >= hang || total >= max) {
        if (speech >= minSpeech) out.push(concat(buf));
        reset();
      }
      return out;
    },
  };
}

/** Linear resampling, for browsers that cannot open an AudioContext at 16 kHz. */
export function resample(samples, from, to = TARGET_RATE) {
  if (from === to) return samples;
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const pos = (i * from) / to;
    const a = Math.floor(pos);
    out[i] = samples[a] + ((samples[Math.min(a + 1, samples.length - 1)] - samples[a]) * (pos - a));
  }
  return out;
}

// Whisper invents text for noise and silence; these are its usual inventions.
const HALLUCINATIONS = /tekstitys|kiitos katsomisesta|kiitos kun katsoit|subtitles|amara\.org|thanks for watching/i;
export function plausible(text) {
  const t = String(text ?? '').trim();
  return /[\p{L}\p{N}]{2}/u.test(t) && !HALLUCINATIONS.test(t);
}

const WORKLET = `class Tap extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0][0]; if (c) this.port.postMessage(c.slice()); return true; }
}
registerProcessor('tap', Tap);`;

/**
 * Opens the microphone and calls onUtterance(samples16k) per finished utterance. While isMuted() is true
 * (our own spoken answers) nothing is collected. Resolves with { stop() }.
 */
export async function startMic({ onUtterance, onSpeechStart = () => {}, isMuted = () => false }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let ctx;
  try { ctx = new AudioContext({ sampleRate: TARGET_RATE }); } catch { ctx = new AudioContext(); }
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'tap');
  const segmenter = createSegmenter({ rate: ctx.sampleRate });
  let wasSpeaking = false;
  node.port.onmessage = (e) => {
    if (isMuted()) { segmenter.reset(); wasSpeaking = false; return; }
    for (const utterance of segmenter.feed(e.data)) onUtterance(resample(utterance, ctx.sampleRate));
    if (segmenter.speaking && !wasSpeaking) onSpeechStart();
    wasSpeaking = segmenter.speaking;
  };
  // Web Audio only pulls nodes that reach the destination; a zero gain keeps the microphone from playing back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination);
  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      ctx.close().catch(() => {});
    },
  };
}

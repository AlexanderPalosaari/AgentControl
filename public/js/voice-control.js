'use strict';
// speech recognition: start and stop.
// Part of the page: these files are plain scripts that share one scope and load in the order listed in index.html.

let hintsSupported = true; // cleared when the engine rejects phrases (e.g. server-side recognition)
function giveRecognitionHints(rec) {
  try {
    if (!hintsSupported || typeof SpeechRecognitionPhrase === 'undefined') return;
    const words = new Set(['agentti']);
    for (const c of cards) for (const w of c.title.split(/[^\p{L}\p{N}-]+/u)) if (w.length >= 4) words.add(w);
    for (const b of document.querySelectorAll('#repo-list button')) words.add(b.textContent);
    rec.phrases = [...words].slice(0, 200).map((w) => new SpeechRecognitionPhrase(w, w === 'agentti' ? 10 : 5));
  } catch { /* hints are optional */ }
}

function startVoice() {
  if (!SpeechRec || pref('ac_local_stt', false)) { startLocalVoice(); return; }
  const rec = new SpeechRec();
  rec.lang = 'fi-FI';
  rec.continuous = true;
  rec.interimResults = true; // live text while talking
  rec.onresult = (ev) => {
    if (voice.speaking || Date.now() < voice.muteUntil) return; // our own voice
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) handleUtterance(r[0].transcript);
      else interim += r[0].transcript;
    }
    if (interim.trim() && (!voice.wake || gate.peek(interim))) say(`… ${interim.trim()}`, 4000);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Selain esti mikrofonin. Salli mikrofoni osoiterivin kuvakkeesta ja kokeile uudelleen.');
      stopVoice();
    } else if (e.error === 'network') {
      // No online speech service (Electron, offline): switch to the local recogniser and remember it.
      savePref('ac_local_stt', true);
      voice.rec = null;
      try { rec.abort(); } catch { /* not running */ }
      startLocalVoice();
    } else if (e.error === 'phrases-not-supported') {
      hintsSupported = false; // retry without hints; onend restarts the recogniser
      rec.phrases = [];
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      say('Puheentunnistus: ' + e.error);
    }
  };
  rec.onend = () => { if (voice.on && voice.rec === rec) setTimeout(() => { giveRecognitionHints(rec); try { rec.start(); } catch { /* already running */ } }, 300); };
  voice.rec = rec;
  giveRecognitionHints(rec);
  voice.on = true;
  try { rec.start(); } catch { /* already running */ }
  setVoiceButton();
  say(voice.wake ? 'Puheohjaus päällä. Sano "agentti, lisää kortti" tai "agentti, komennot".' : 'Puheohjaus päällä. Sano esim. "lisää kortti" tai "komennot".');
}

// Local recognition: the microphone is cut into utterances in the page and each one is transcribed by Whisper on the server.
async function transcribeLocal(samples) {
  say('Tunnistetaan…', 60_000);
  try {
    const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: samples });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (!voice.on) return;
    if (!plausible(data.text)) { say(''); return; }
    say(!voice.wake || gate.peek(data.text) ? `… ${data.text.trim()}` : '', 3000);
    handleUtterance(data.text);
  } catch (e) {
    say('Puheentunnistus: ' + e.message);
  }
}

async function startLocalVoice() {
  let mic = null;
  const local = { stop() { mic?.stop(); } };
  voice.rec = local;
  voice.on = true;
  setVoiceButton();
  try {
    mic = await startMic({
      isMuted: () => voice.speaking || Date.now() < voice.muteUntil, // our own voice
      onSpeechStart: () => { if (!voice.wake) say('… kuuntelen', 2000); },
      onUtterance: transcribeLocal,
    });
  } catch (e) {
    toast('Mikrofonia ei saatu käyttöön: ' + e.message);
    stopVoice();
    return;
  }
  if (voice.rec !== local) { mic.stop(); return; } // stopped while the microphone was opening
  say(voice.wake ? 'Puheohjaus päällä. Sano "agentti, lisää kortti" tai "agentti, komennot".' : 'Puheohjaus päällä. Sano esim. "lisää kortti" tai "komennot".');
}

function stopVoice() {
  voice.on = false;
  voice.dictating = null;
  clearTimeout(dictTimer);
  const rec = voice.rec;
  voice.rec = null;
  try { rec?.stop(); } catch { /* not running */ }
  try { speechSynthesis.cancel(); } catch { /* not supported */ }
  setVoiceButton();
  say('');
}

vbtn.addEventListener('click', () => (voice.on ? stopVoice() : startVoice()));
wakeBtn.addEventListener('click', () => {
  voice.wake = !voice.wake;
  savePref('ac_wake', voice.wake);
  setVoiceButton();
  say(voice.wake ? 'Herätesana päällä: aloita sanomalla "agentti".' : 'Herätesana pois: kaikki puhe tulkitaan komennoksi.');
});
ttsBtn.addEventListener('click', () => {
  voice.tts = !voice.tts;
  savePref('ac_tts', voice.tts);
  if (!voice.tts) { try { speechSynthesis.cancel(); } catch { /* not supported */ } voice.speaking = false; }
  setVoiceButton();
});
setVoiceButton();
// Voice control always starts off: the person turns it on with the button.

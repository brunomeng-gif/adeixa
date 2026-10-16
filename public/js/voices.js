// Vozes sintéticas do próprio navegador (Web Speech API).
// No Edge aparecem vozes "Natural" em português bem melhores que no Chrome.

let voicesReady;
export function loadVoices() {
  if (!voicesReady) {
    voicesReady = new Promise(resolve => {
      const done = () => resolve(speechSynthesis.getVoices());
      const v = speechSynthesis.getVoices();
      if (v.length) return done();
      speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 2500);
    });
  }
  return voicesReady;
}

export async function portugueseVoices() {
  const all = await loadVoices();
  const pt = all.filter(v => /^pt/i.test(v.lang));
  const score = v => (/pt-BR/i.test(v.lang) ? 2 : 0) + (/natural|online|neural/i.test(v.name) ? 1 : 0);
  return (pt.length ? pt : all).sort((a, b) => score(b) - score(a));
}

// Sugere uma voz diferente (ou um tom diferente) para cada personagem.
export async function defaultVoiceConfig(characters) {
  const voices = await portugueseVoices();
  const pitches = [1, 0.8, 1.2, 0.9, 1.1, 0.7, 1.3];
  const cfg = {};
  characters.forEach((name, i) => {
    const voice = voices[i % Math.max(voices.length, 1)];
    cfg[name] = {
      voiceURI: voice ? voice.voiceURI : '',
      pitch: pitches[Math.floor(i / Math.max(voices.length, 1)) % pitches.length],
      rate: 1,
    };
  });
  return cfg;
}

// Fala o texto e resolve quando termina. O Chrome corta falas longas, então
// o texto é dividido em frases.
export function speak(text, { voiceURI, pitch = 1, rate = 1 } = {}, signal) {
  return new Promise(async resolve => {
    const voices = await loadVoices();
    const voice = voices.find(v => v.voiceURI === voiceURI);
    const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
    let i = 0;
    const onAbort = () => { speechSynthesis.cancel(); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const next = () => {
      if (signal?.aborted) return;
      if (i >= parts.length) { signal?.removeEventListener('abort', onAbort); resolve(); return; }
      const u = new SpeechSynthesisUtterance(parts[i++].trim());
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'pt-BR';
      u.pitch = pitch;
      u.rate = rate;
      u.onend = next;
      u.onerror = next;
      speechSynthesis.speak(u);
    };
    speechSynthesis.cancel();
    next();
  });
}

// No celular (principalmente iPhone), áudio e voz só tocam se forem "liberados"
// dentro de um toque do usuário. Chame unlockAudio() no clique que inicia o ensaio;
// o mesmo elemento de áudio é reaproveitado depois para tocar as gravações.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let sharedAudio;
export function unlockAudio() {
  if (!sharedAudio) sharedAudio = new Audio();
  sharedAudio.src = SILENCE;
  sharedAudio.play().catch(() => {});
  if (window.speechSynthesis) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

export function playBlob(blob, signal, rate = 1) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const audio = sharedAudio || (sharedAudio = new Audio());
    audio.src = url;
    audio.playbackRate = rate;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      audio.onended = audio.onerror = null;
      audio.pause();
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = finish;
    audio.onerror = finish;
    signal?.addEventListener('abort', finish, { once: true });
    audio.play().catch(finish);
  });
}

// Mantém a tela acesa durante o ensaio (o celular apagaria a tela no meio da cena).
let wakeLock = null;
export async function keepScreenOn(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* sem suporte ou negado: segue sem */ }
}

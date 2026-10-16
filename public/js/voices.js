import { audioContext } from './vad.js';

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

// ---- gênero das vozes ----
// O navegador não informa o gênero da voz: deduzimos pelo nome (Daniel, Maria…).
// No Chrome do Android só existe uma voz por idioma (feminina); a voz masculina
// é simulada deixando o tom mais grave.
const FEMALE = /female|feminin|mulher|maria|francisca|thalita|brenda|elza|giovanna|leila|let[ií]cia|manuela|yara|fernanda|raquel|h[eé]lia|luciana|joana|catarina|in[eê]s|heloisa|helena|vit[oó]ria|camila|google/i;
const MALE = /\bmale\b|masculin|homem|daniel|ant[oô]nio|donato|f[aá]bio|humberto|j[uú]lio|nicolau|val[eé]rio|duarte|felipe|ricardo|cristiano|jo[aã]o|pedro/i;

export function genderOfVoice(v) {
  if (!v) return null;
  if (/\bfemale\b/i.test(v.name)) return 'f';
  if (MALE.test(v.name)) return 'm';
  if (FEMALE.test(v.name)) return 'f';
  return null;
}

// Sem pista no nome, considera feminina: é a voz padrão dos sintetizadores (Android inclusive).
const genderOf = v => genderOfVoice(v) ?? 'f';

// Palpite para personagens novos (dá para trocar na tela de vozes).
export function guessGender(character) {
  const first = character.replace(/^VOZ D[EOA]S?\s+/i, '').split(/\s+/)[0] || '';
  return /[AY]$/i.test(first) ? 'f' : 'm';
}

// Decide qual voz do aparelho usar e com que tom, respeitando o gênero escolhido.
export function resolveVoice(cfg = {}, voices) {
  const pt = voices.filter(v => /^pt/i.test(v.lang));
  const pool = pt.length ? pt : voices;
  const wanted = cfg.gender;
  const chosen = pool.find(v => v.voiceURI === cfg.voiceURI);
  if (chosen && (!wanted || genderOf(chosen) === wanted)) return { voice: chosen, pitch: cfg.pitch ?? 1, simulated: false };

  // Vozes do gênero pedido, com pt-BR e as instaladas no aparelho primeiro.
  const rank = v => (/^pt[-_]BR/i.test(v.lang) ? 2 : 0) + (v.localService ? 1 : 0);
  const sorted = [...pool].sort((a, b) => rank(b) - rank(a));
  let sameGender = wanted ? sorted.filter(v => genderOf(v) === wanted) : sorted;
  // Na escolha automática, fica no português do Brasil (Portugal só se escolhido na lista).
  const br = sameGender.filter(v => /^pt[-_]BR/i.test(v.lang));
  if (br.length) sameGender = br;
  if (sameGender.length) {
    return { voice: sameGender[(cfg.variant || 0) % sameGender.length], pitch: cfg.pitch ?? 1, simulated: false };
  }
  // Não há voz desse gênero: usa a escolhida (ou a melhor disponível) e ajusta o tom.
  const voice = chosen || sorted[0] || null;
  const shift = wanted === 'm' ? 0.72 : wanted === 'f' ? 1.3 : 1;
  return { voice, pitch: Math.min(2, Math.max(0.1, (cfg.pitch ?? 1) * shift)), simulated: !!wanted };
}

// No Android todos do mesmo gênero usam a mesma voz: o tom é o que os diferencia.
const PITCHES = [1, 0.88, 1.12, 0.8, 1.2, 0.94, 1.06];

// Troca o gênero de um personagem, dando a ele voz/tom diferentes dos outros do mesmo gênero.
export function setGender(voicesCfg, name, gender) {
  const n = Object.entries(voicesCfg).filter(([k, c]) => k !== name && k !== '__narrador' && c.gender === gender).length;
  Object.assign(voicesCfg[name], { gender, voiceURI: '', variant: n, pitch: PITCHES[n % PITCHES.length] });
}

// Sugere a configuração de voz de cada personagem: gênero pelo nome e um tom
// um pouco diferente para personagens do mesmo gênero.
export function defaultVoiceConfig(characters) {
  const count = { f: 0, m: 0 };
  const cfg = {};
  characters.forEach(name => {
    const gender = guessGender(name);
    const n = count[gender]++;
    cfg[name] = { gender, voiceURI: '', variant: n, pitch: PITCHES[n % PITCHES.length], rate: 1 };
  });
  return cfg;
}

// Fala o texto e resolve quando termina. onStart é chamado quando o som começa.
export function speak(text, cfg = {}, signal, onStart) {
  const { rate = 1 } = cfg;
  return new Promise(async resolve => {
    const voices = await loadVoices();
    // A voz escolhida no computador pode não existir no celular: escolhe outra do
    // mesmo gênero instalada no aparelho (as que vêm pela internet demoram mais).
    const { voice, pitch } = resolveVoice(cfg, voices);
    // O Chrome do computador corta falas muito longas; só nesse caso divide em frases
    // (cada pedaço a mais acrescenta uma pequena pausa no celular).
    const parts = text.length > 200 ? (text.match(/[^.!?…]+[.!?…]*\s*/g) || [text]) : [text];
    let i = 0, started = false;
    const onAbort = () => { speechSynthesis.cancel(); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const next = () => {
      if (signal?.aborted) return;
      if (i >= parts.length) { signal?.removeEventListener('abort', onAbort); resolve(); return; }
      const u = new SpeechSynthesisUtterance(parts[i++].trim());
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'pt-BR';
      u.pitch = pitch;
      u.rate = rate;
      u.onstart = () => { if (!started) { started = true; onStart?.(); } };
      u.onend = next;
      u.onerror = next;
      speechSynthesis.speak(u);
    };
    // Cancelar sem necessidade atrasa a próxima fala em alguns Androids.
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    next();
  });
}

// No celular (principalmente iPhone), áudio e voz só tocam se forem "liberados"
// dentro de um toque do usuário. Chame unlockAudio() no clique que inicia o ensaio;
// o mesmo elemento de áudio é reaproveitado depois para tocar as gravações.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let sharedAudio;
export function unlockAudio() {
  audioContext(); // o medidor de volume também precisa ser liberado pelo toque
  if (!sharedAudio) sharedAudio = new Audio();
  sharedAudio.src = SILENCE;
  sharedAudio.play().catch(() => {});
  if (window.speechSynthesis) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

export function playBlob(blob, signal, rate = 1, onStart) {
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
    audio.onplaying = () => { audio.onplaying = null; onStart?.(); };
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

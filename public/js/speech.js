// Escuta o ator (reconhecimento de voz do navegador) e decide quando a fala
// dele terminou, comparando o que foi ouvido com o texto esperado.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const recognitionSupported = !!Recognition;
// No Android, o sistema toca um bipe toda vez que o reconhecimento liga/desliga.
export const isAndroid = /Android/i.test(navigator.userAgent || '');

export function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const words = s => normalize(s).split(' ').filter(Boolean);
// Palavras do texto original (para mostrar na tela) junto com a forma normalizada.
const tokens = s => s.split(/\s+/).map(display => ({ display, norm: normalize(display).replace(/ /g, '') })).filter(t => t.norm);

function similar(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return a.startsWith(b) || b.startsWith(a);
  let diff = 0;
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return true;
}

// Alinha as palavras esperadas com as ouvidas, tolerando palavras puladas
// ou a mais. Devolve quais palavras esperadas foram ditas.
export function compare(expected, heard) {
  const toks = tokens(expected), exp = toks.map(t => t.norm), got = words(heard);
  const matched = new Array(exp.length).fill(false);
  let j = 0;
  for (let i = 0; i < exp.length; i++) {
    for (let k = j; k < Math.min(got.length, j + 5); k++) {
      if (similar(exp[i], got[k])) { matched[i] = true; j = k + 1; break; }
    }
  }
  const hits = matched.filter(Boolean).length;
  const tail = exp.slice(-2).map((_, n) => matched[exp.length - 1 - n]);
  const last = exp[exp.length - 1];
  // A última palavra às vezes vem quebrada ("de mora" no lugar de "demora").
  const lastSaid = !exp.length || matched[exp.length - 1]
    || (got.length > 0 && (got.slice(-3).join('').endsWith(last) || similar(got[got.length - 1], last)));
  return {
    words: toks.map(t => t.display),
    matched,
    coverage: exp.length ? hits / exp.length : 1,
    endReached: tail.some(Boolean),
    lastSaid,
    nextMissing: matched.indexOf(false),
  };
}

// Junta os resultados de uma sessão de reconhecimento. O Chrome do Android às
// vezes repete o texto acumulado em resultados separados ("o que", "o que passar"):
// quando um resultado começa com o anterior, fica só o mais longo.
function sessionText(results) {
  const parts = [];
  for (let i = 0; i < results.length; i++) {
    const t = results[i][0].transcript.trim();
    if (!t) continue;
    const prev = parts[parts.length - 1];
    if (prev !== undefined && normalize(t).startsWith(normalize(prev))) parts[parts.length - 1] = t;
    else if (prev !== undefined && normalize(prev).startsWith(normalize(t))) continue;
    else parts.push(t);
  }
  return parts.join(' ');
}

// Escuta uma fala. Resolve com { transcript, reason, timing } assim que o ator termina.
//  pauseMs: quanto silêncio esperar depois da última palavra antes de dar a deixa.
//  meter: medidor de volume (vad.js), opcional. Com ele, o fim da fala é percebido
//         na hora, sem esperar o reconhecimento entregar o texto.
//  expectedVoiceMs: quanto tempo de voz a fala costuma levar (aprendido nos ensaios).
//  nearEndFactor: que fração desse tempo conta como "perto do fim". Menor = mais
//         rápido, mas arrisca cortar uma pausa; maior = mais seguro.
//  useText: false = não usa o reconhecimento de texto, só o medidor de volume
//         (sem os bipes do Android; o fim da fala vem do ritmo aprendido).
//  onUpdate(transcript, result) é chamado a cada trecho reconhecido.
//  onPrompt() é chamado quando o ator diz "texto" (pedindo o ponto).
export const DEFAULT_MS_PER_WORD = 250;
export function listenForLine(expected, { onUpdate, onPrompt, signal, pauseMs = 300, meter = null, expectedVoiceMs = null, nearEndFactor = 0.7, useText = true } = {}) {
  return new Promise(resolve => {
    // Objeto vazio no lugar do reconhecimento quando ele não é usado.
    const rec = useText && Recognition ? new Recognition() : { start() {}, abort() {} };
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;

    let previous = '', session = '', lastHeard = Date.now(), done = false, failures = 0;
    const started = Date.now();
    const current = () => (previous + ' ' + session).trim();
    // Tempo de voz esperado para a fala (só os trechos com som, sem as pausas entre palavras).
    const expectedMs = expectedVoiceMs ?? compare(expected, '').words.length * DEFAULT_MS_PER_WORD;
    meter?.reset();

    const finish = reason => {
      if (done) return;
      done = true;
      clearInterval(timer);
      rec.onend = null;
      try { rec.abort(); } catch { /* já parado */ }
      resolve({
        transcript: current(),
        reason,
        coverage: compare(expected, current()).coverage,
        voicedMs: meter && meter.working ? meter.voicedMs : null,
        timing: { finishedAt: Date.now(), voiceEnd: meter?.lastVoiceAt || null, textEnd: lastHeard },
      });
    };

    const check = () => {
      if (done) return;
      const now = Date.now();
      const heard = current();
      const r = compare(expected, heard);
      const usingVoice = meter && meter.working && meter.lastVoiceAt > 0;
      const voiceQuiet = usingVoice ? now - meter.lastVoiceAt : null;
      const textQuiet = now - lastHeard;

      if (!heard && !usingVoice) {
        if (now - started > 8000 && textQuiet > 8000) { onPrompt?.(); lastHeard = now; }
        return;
      }
      // Disse a última palavra: responde logo.
      if (heard && r.lastSaid && r.coverage >= 0.6 && (voiceQuiet ?? textQuiet) >= Math.max(pauseMs, usingVoice ? 120 : 0)) return finish('complete');
      if (usingVoice) {
        // O volume mostra que parou de falar; o texto pode ainda não ter chegado.
        const nearEnd = r.lastSaid || r.endReached || r.coverage >= 0.7 || meter.voicedMs >= expectedMs * nearEndFactor;
        if (nearEnd && voiceQuiet >= Math.max(pauseMs, 250)) return finish('voice');
        if (voiceQuiet < 400) return; // ainda falando: nada de cortar
      }
      // Quase tudo dito (o reconhecimento pode ter errado a última palavra).
      if (r.coverage >= 0.9 && textQuiet >= pauseMs + 700) return finish('silence');
      // Falou algo e parou de vez: segue mesmo assim. Espera mais para não
      // cortar uma pausa dramática no meio da fala.
      if (Math.min(textQuiet, voiceQuiet ?? Infinity) >= pauseMs + 2500) return finish('silence');
    };

    rec.onresult = e => {
      const last = e.results[e.results.length - 1];
      if (last.isFinal && /^\s*texto\s*\??\s*$/i.test(last[0].transcript)) { onPrompt?.(); return; }
      session = sessionText(e.results);
      lastHeard = Date.now();
      failures = 0;
      onUpdate?.(current(), compare(expected, current()));
      check();
    };
    // O Chrome encerra a escuta sozinho (no Android, a cada pausa): reinicia.
    rec.onend = () => {
      if (done) return;
      previous = current();
      session = '';
      // Se o reconhecimento falha seguidamente, para de insistir (o medidor de volume segue valendo).
      if (failures < 3) try { rec.start(); } catch { /* ignora */ }
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') finish('mic-blocked');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') failures++;
    };

    const timer = setInterval(check, 40);
    if (signal?.aborted) return finish('aborted');
    signal?.addEventListener('abort', () => finish('aborted'), { once: true });
    try { rec.start(); } catch { finish('error'); }
  });
}

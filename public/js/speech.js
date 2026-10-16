// Escuta o ator (reconhecimento de voz do navegador) e decide quando a fala
// dele terminou, comparando o que foi ouvido com o texto esperado.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const recognitionSupported = !!Recognition;

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

// Escuta uma fala. Resolve com { transcript, reason } assim que o ator termina.
//  pauseMs: quanto silêncio esperar depois da última palavra antes de dar a deixa.
//  onUpdate(transcript, result) é chamado a cada trecho reconhecido.
//  onPrompt() é chamado quando o ator diz "texto" (pedindo o ponto).
export function listenForLine(expected, { onUpdate, onPrompt, signal, pauseMs = 300 } = {}) {
  return new Promise(resolve => {
    const rec = new Recognition();
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;

    let finalText = '', interim = '', lastHeard = Date.now(), started = Date.now(), done = false;
    const current = () => (finalText + ' ' + interim).trim();

    const finish = reason => {
      if (done) return;
      done = true;
      clearInterval(timer);
      rec.onend = null;
      try { rec.abort(); } catch { /* já parado */ }
      resolve({ transcript: current(), reason });
    };

    const check = () => {
      if (done) return;
      const heard = current();
      const quiet = Date.now() - lastHeard;
      if (!heard) {
        if (Date.now() - started > 8000 && quiet > 8000) { onPrompt?.(); lastHeard = Date.now(); }
        return;
      }
      const r = compare(expected, heard);
      // Disse a última palavra: responde logo.
      if (r.lastSaid && r.coverage >= 0.6 && quiet >= pauseMs) finish('complete');
      // Quase tudo dito (o reconhecimento pode ter errado a última palavra).
      else if (r.coverage >= 0.9 && quiet >= pauseMs + 700) finish('silence');
      // Falou algo e parou de vez: segue mesmo assim. Espera mais para não
      // cortar uma pausa dramática no meio da fala.
      else if (quiet >= pauseMs + 2500) finish('silence');
    };

    rec.onresult = e => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          if (/^\s*texto\s*\??\s*$/i.test(t)) { onPrompt?.(); continue; }
          finalText += ' ' + t;
        } else interim += ' ' + t;
      }
      lastHeard = Date.now();
      onUpdate?.(current(), compare(expected, current()));
      check();
    };
    // O Chrome encerra a escuta sozinho depois de um tempo: reinicia.
    rec.onend = () => { if (!done) try { rec.start(); } catch { /* ignora */ } };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') finish('mic-blocked');
    };

    const timer = setInterval(check, 50);
    signal?.addEventListener('abort', () => finish('aborted'), { once: true });
    try { rec.start(); } catch { finish('error'); }
  });
}

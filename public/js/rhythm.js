// Aprende o ritmo do ator para saber quando uma fala está perto do fim, mesmo
// sem o texto reconhecido (no Android ele chega atrasado).
//  - geral: quanto tempo de voz o ator leva por palavra;
//  - por fala: quanto tempo de voz cada fala levou nos ensaios anteriores.
// stats = { msPerWord, samples, lines: { [blockId]: { ms, n } } }
import { DEFAULT_MS_PER_WORD } from './speech.js';

export const emptyStats = () => ({ msPerWord: null, samples: 0, lines: {} });

// Quanto tempo de voz esperar desta fala, e que fração dele já conta como "perto do fim".
export function expectationFor(stats, blockId, wordCount) {
  const line = stats?.lines?.[blockId];
  if (line) return { expectedVoiceMs: line.ms, nearEndFactor: 0.85, source: 'fala' };
  if (stats?.msPerWord && stats.samples >= 3) {
    return { expectedVoiceMs: wordCount * stats.msPerWord, nearEndFactor: 0.75, source: 'ritmo' };
  }
  return { expectedVoiceMs: wordCount * DEFAULT_MS_PER_WORD, nearEndFactor: 0.7, source: 'padrão' };
}

// Registra quanto tempo de voz a fala levou. Devolve true se aprendeu algo.
export function learn(stats, blockId, wordCount, out) {
  if (!out || !out.voicedMs || !['complete', 'voice', 'silence'].includes(out.reason)) return false;
  const measured = out.voicedMs;

  // Por fala. Sobe rápido e desce devagar: se a deixa veio cedo demais (o ator
  // ainda ia continuar), a medição sai menor que o real, e isso não pode puxar
  // a referência para baixo a cada ensaio.
  const line = stats.lines[blockId];
  if (!line) stats.lines[blockId] = { ms: Math.round(measured), n: 1 };
  else {
    const w = measured >= line.ms ? 0.5 : 0.15;
    line.ms = Math.round(line.ms * (1 - w) + measured * w);
    line.n++;
  }

  // Geral (só falas com 3+ palavras; as curtas variam demais).
  if (wordCount >= 3) {
    const perWord = Math.min(600, Math.max(100, measured / wordCount));
    stats.msPerWord = stats.msPerWord ? Math.round(stats.msPerWord * 0.8 + perWord * 0.2) : Math.round(perWord);
    stats.samples++;
  }
  return true;
}

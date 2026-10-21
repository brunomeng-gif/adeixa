// Testa quanto tempo o app leva para dar a deixa depois que o ator para de falar,
// simulando o reconhecimento de voz e o medidor de volume com um relógio falso.
// Uso: node test/timing.mjs

// ---- relógio simulado ----
let now = 0;
const timers = [];
let nextId = 1;
Date.now = () => now;
globalThis.setTimeout = (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id; };
globalThis.setInterval = (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn, every: ms }); return id; };
globalThis.clearTimeout = globalThis.clearInterval = id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
async function advance(until) {
  while (true) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > until) break;
    now = t.at;
    if (t.every) t.at += t.every; else timers.shift();
    t.fn();
    await Promise.resolve();
  }
  now = until;
}

// ---- reconhecimento falso: entrega textos em momentos definidos ----
let script = [];
class FakeRecognition {
  start() { for (const [ms, text, isFinal] of script) setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: text }], { isFinal: !!isFinal })] }), ms); }
  stop() {}
  abort() {}
}
globalThis.window = { SpeechRecognition: FakeRecognition };
const { listenForLine } = await import('../public/js/speech.js');

// ---- medidor falso: há voz até `voiceUntil`, exceto nas pausas `gaps` ----
function fakeMeter(voiceUntil, gaps = []) {
  const m = { lastVoiceAt: 0, voicedMs: 0, working: true, reset() { this.lastVoiceAt = 0; this.voicedMs = 0; } };
  const id = setInterval(() => {
    if (now < voiceUntil && !gaps.some(([a, b]) => now >= a && now < b)) { m.lastVoiceAt = now; m.voicedMs += 30; }
    if (now > voiceUntil + 10000) clearInterval(id);
  }, 30);
  return m;
}

async function trial({ name, results, voiceUntil, pauseMs, gaps, expected = 'O que passar primeiro eu pego. Demora?', meter = true, expectMax, expectMin = 0, opts = {} }) {
  now = 0; timers.length = 0; script = results;
  let out = null;
  listenForLine(expected, { pauseMs, meter: meter ? fakeMeter(voiceUntil, gaps) : null, ...opts }).then(o => { out = o; });
  for (let t = 0; t < 20000 && !out; t += 10) await advance(t);
  const delay = out.timing.finishedAt - voiceUntil;
  const ok = delay <= expectMax && delay >= expectMin;
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${name}: deixa ${delay} ms depois de parar de falar (${out.reason})`);
  if (!ok) process.exitCode = 1;
  return out;
}

// Android: o texto só chega bem depois de o ator parar (o caso que estava lento).
const android = [[900, 'o que passar'], [3200, 'o que passar primeiro eu pego demora', true]];
await trial({ name: 'Android, ajuste 0,3 s', results: android, voiceUntil: 2000, pauseMs: 300, expectMax: 400 });
await trial({ name: 'Android, ajuste imediato', results: android, voiceUntil: 2000, pauseMs: 0, expectMax: 330 });
await trial({ name: 'Android, ajuste 1 s', results: android, voiceUntil: 2000, pauseMs: 1000, expectMin: 950, expectMax: 1100 });
// Computador: o texto acompanha a fala.
const desktop = [[400, 'o que passar'], [1000, 'o que passar primeiro eu pego'], [1900, 'o que passar primeiro eu pego demora']];
await trial({ name: 'Computador, ajuste 0,3 s', results: desktop, voiceUntil: 2000, pauseMs: 300, expectMax: 400 });
await trial({ name: 'Sem medidor (só texto), ajuste 0,3 s', results: desktop, voiceUntil: 1900, pauseMs: 300, meter: false, expectMax: 400 });
// Pausa dramática de 1,2 s no meio da fala não pode disparar a deixa.
await trial({ name: 'Pausa no meio da fala', results: [[600, 'o que passar'], [3800, 'o que passar primeiro eu pego demora', true]], voiceUntil: 2600, pauseMs: 300, gaps: [[700, 1900]], expectMin: 0, expectMax: 400 });
await trial({ name: 'Fala curta "Não."', results: [[1500, 'não', true]], voiceUntil: 400, pauseMs: 300, expected: 'Não.', expectMax: 400 });

// ---- ritmo aprendido (rhythm.js) ----
const { emptyStats, expectationFor, learn } = await import('../public/js/rhythm.js');
const LONG = 'Cara, não vou jogar um isqueiro desses fora. Você faz ideia de quanto tempo isso aqui leva pra se desintegrar na natureza?';
const words = 20; // palavras de LONG
// Android: o texto final só chega 1,2 s depois de o ator parar.
const late = end => [[end + 1200, LONG, true]];

// Ator lento (300 ms de voz por palavra = 6 s) com uma pausa dramática de 1,2 s aos 75% da fala.
const stats = emptyStats();
let exp = expectationFor(stats, 'b1', words);
await trial({ name: 'Ator lento, sem ritmo aprendido: pausa aos 75% CORTA a fala', expected: LONG, results: late(7200), voiceUntil: 7200, pauseMs: 300, gaps: [[4500, 5700]], opts: exp, expectMax: -1500, expectMin: -3000 });
// Ele passa a fala inteira uma vez (sem a pausa) e o app aprende quanto ela dura.
let out = await trial({ name: 'Ator lento, fala inteira (aprendendo)', expected: LONG, results: late(6000), voiceUntil: 6000, pauseMs: 300, opts: exp, expectMax: 400 });
learn(stats, 'b1', words, out);
exp = expectationFor(stats, 'b1', words);
await trial({ name: 'Ator lento, com ritmo aprendido: pausa aos 75% não corta', expected: LONG, results: late(7200), voiceUntil: 7200, pauseMs: 300, gaps: [[4500, 5700]], opts: exp, expectMax: 400 });

// Ator rápido (150 ms/palavra = 3 s): sem ritmo, a voz nunca chega ao "perto do fim" padrão.
const fast = emptyStats();
exp = expectationFor(fast, 'b2', words);
out = await trial({ name: 'Ator rápido, sem ritmo aprendido: deixa demora', expected: LONG, results: late(3000), voiceUntil: 3000, pauseMs: 300, opts: exp, expectMin: 1000, expectMax: 3000 });
learn(fast, 'b2', words, out);
exp = expectationFor(fast, 'b2', words);
await trial({ name: 'Ator rápido, com ritmo aprendido: deixa rápida', expected: LONG, results: late(3000), voiceUntil: 3000, pauseMs: 300, opts: exp, expectMax: 400 });

// Uma deixa que veio cedo (medição menor) puxa a referência só um pouco para baixo.
const before = stats.lines.b1.ms;
learn(stats, 'b1', words, { reason: 'voice', voicedMs: before * 0.6 });
const drop = 1 - stats.lines.b1.ms / before;
console.log(`${drop < 0.1 ? 'ok  ' : 'FALHOU'} Medição curta baixa a referência só ${Math.round(drop * 100)}%`);
if (drop >= 0.1) process.exitCode = 1;

// ---- modo sem bipes (Android): só o medidor de volume, sem reconhecimento de texto ----
const noText = { useText: false };
const created = [];
const RealRec = globalThis.window.SpeechRecognition;
globalThis.window.SpeechRecognition = class extends RealRec { constructor() { super(); created.push(this); } };
const { listenForLine: listenNoBeep } = await import('../public/js/speech.js?sem-bipe');
await trial({ name: 'Sem bipes, fala curta', results: [], voiceUntil: 1500, pauseMs: 300, opts: noText, expectMax: 400 });
const quiet = emptyStats();
exp = expectationFor(quiet, 'b3', words);
out = await trial({ name: 'Sem bipes, fala longa (1º ensaio)', expected: LONG, results: [], voiceUntil: 5000, pauseMs: 300, opts: { ...noText, ...exp }, expectMax: 400 });
learn(quiet, 'b3', words, out);
exp = expectationFor(quiet, 'b3', words);
await trial({ name: 'Sem bipes, com ritmo aprendido: pausa aos 75% não corta', expected: LONG, results: [], voiceUntil: 6200, pauseMs: 300, gaps: [[3750, 4950]], opts: { ...noText, ...exp }, expectMax: 400 });
await listenNoBeep('Teste.', { useText: false, signal: AbortSignal.abort() });
console.log(`${created.length === 0 ? 'ok  ' : 'FALHOU'} Sem bipes: o reconhecimento de texto nunca é ligado`);
if (created.length) process.exitCode = 1;

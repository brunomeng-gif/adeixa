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

async function trial({ name, results, voiceUntil, pauseMs, gaps, expected = 'O que passar primeiro eu pego. Demora?', meter = true, expectMax, expectMin = 0 }) {
  now = 0; timers.length = 0; script = results;
  let out = null;
  listenForLine(expected, { pauseMs, meter: meter ? fakeMeter(voiceUntil, gaps) : null }).then(o => { out = o; });
  for (let t = 0; t < 20000 && !out; t += 10) await advance(t);
  const delay = out.timing.finishedAt - voiceUntil;
  const ok = delay <= expectMax && delay >= expectMin;
  console.log(`${ok ? 'ok  ' : 'FALHOU'} ${name}: deixa ${delay} ms depois de parar de falar (${out.reason})`);
  if (!ok) process.exitCode = 1;
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

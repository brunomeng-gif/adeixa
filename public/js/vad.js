// Medidor de voz pelo volume do microfone. Serve para saber, sem atraso,
// quando o ator parou de falar: o reconhecimento de voz do Android só entrega
// o texto depois de 1–2 s de silêncio, o que deixava as deixas lentas.

let ctx = null;

// Precisa ser chamado dentro de um toque do usuário (celular).
export function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export async function startVoiceMeter() {
  const ac = audioContext();
  if (!ac || !navigator.mediaDevices?.getUserMedia) return null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    return null;
  }
  const source = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let noise = 0.01;     // nível do ruído de fundo (se adapta ao ambiente)
  let last = Date.now();
  let voicedRun = 0;    // ms seguidos acima do limiar (ignora estalos curtos)

  const meter = {
    lastVoiceAt: 0,     // última vez que ouviu voz
    voicedMs: 0,        // quanto tempo de voz desde o último reset
    working: false,     // já captou algum som? (no Android o 2º uso do microfone pode vir mudo)
    reset() { this.lastVoiceAt = 0; this.voicedMs = 0; voicedRun = 0; },
    stop() {
      clearInterval(timer);
      source.disconnect();
      stream.getTracks().forEach(t => t.stop());
    },
  };

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    const dt = now - last;
    last = now;
    if (rms > 0.0005) meter.working = true;

    // O ruído de fundo desce rápido e sobe devagar.
    noise = rms < noise ? noise * 0.8 + rms * 0.2 : noise * 0.998 + rms * 0.002;
    const voiced = rms > Math.max(noise * 3, 0.01);
    voicedRun = voiced ? voicedRun + dt : 0;
    if (voicedRun >= 60) {
      meter.voicedMs += dt;
      meter.lastVoiceAt = now;
    }
  }, 30);

  return meter;
}

// Motor do ensaio: percorre os blocos da cena, fala as deixas dos outros
// personagens e espera (ou escuta) as falas do ator.
import { speak, playBlob } from './voices.js';
import { listenForLine, recognitionSupported } from './speech.js';
import { startVoiceMeter } from './vad.js';

const wait = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const untilAborted = signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));

export class Rehearsal {
  // opts: { blocks, isMine(block), voiceFor(character), narratorVoice, recordingFor(block),
  //         readDirections, autoListen, rate, pauseMs, ui }
  // rate e pauseMs podem ser alterados durante o ensaio e valem a partir da próxima fala.
  constructor(opts) {
    Object.assign(this, opts);
    this.i = 0;
    this.running = false;
    this.autoListen = opts.autoListen && recognitionSupported;
  }

  get current() { return this.blocks[this.i]; }

  async start(index = this.i) {
    this.i = index;
    if (this.running) return;
    this.running = true;
    const loop = this.loop = (this.loop || 0) + 1;
    this.ui.state('playing');
    // Medidor de volume: percebe na hora quando o ator para de falar.
    if (this.autoListen && !this.meterTried) {
      this.meterTried = true;
      this.meter = await startVoiceMeter();
    }
    while (this.running && this.i < this.blocks.length) {
      this.ctrl = new AbortController();
      this.jumpTo = undefined;
      this.ui.focus(this.i);
      await this.step(this.blocks[this.i], this.ctrl.signal);
      if (loop !== this.loop) return; // um novo ciclo já assumiu (pausa + continuar)
      if (this.jumpTo !== undefined) this.i = this.jumpTo;
      else if (this.running) this.i++;
    }
    if (this.i >= this.blocks.length) {
      this.running = false;
      this.ui.state('finished');
      this.ui.finished();
    }
  }

  async step(block, signal) {
    if (block.type === 'scene') return wait(500, signal);
    if (block.type === 'direction') {
      if (this.readDirections) return speak(block.text, this.narratorVoice, signal);
      return wait(300, signal); // a rubrica fica na tela; não segura o ritmo
    }
    if (this.isMine(block)) return this.myLine(block, signal);

    const rec = await this.recordingFor(block);
    if (signal.aborted) return;
    // Para o diagnóstico: quanto tempo entre o fim da fala do ator e o início da deixa.
    const after = this.lastMine;
    this.lastMine = null;
    const onStart = () => { if (after) this.ui.timing?.({ ...after, cueStart: Date.now() }); };
    if (rec) await playBlob(rec.blob, signal, this.rate, onStart);
    else await speak(block.spoken || block.text, { ...this.voiceFor(block.character), rate: (this.voiceFor(block.character).rate || 1) * this.rate }, signal, onStart);
    return wait(100, signal);
  }

  async myLine(block, signal) {
    this.ui.waitingForMe(block);
    if (!this.autoListen) return untilAborted(signal);
    const expected = block.spoken || block.text;
    const out = await listenForLine(expected, {
      signal,
      onUpdate: (transcript, result) => this.ui.heard(transcript, result),
      onPrompt: () => this.ui.prompt(),
      pauseMs: this.pauseMs,
      meter: this.meter,
    });
    if (out.reason !== 'aborted' && out.reason !== 'mic-blocked') this.lastMine = out;
    if (out.reason === 'mic-blocked') {
      this.autoListen = false;
      this.ui.notice('Não consegui acessar o microfone. Siga com o botão "Próxima" (ou a barra de espaço).');
      return untilAborted(signal);
    }
  }

  // ---- controles ----
  pause() {
    this.running = false;
    this.ctrl?.abort();
    speechSynthesis.cancel();
    this.jumpTo = this.i;
    this.ui.state('paused');
  }
  resume() { this.start(this.i); }
  goTo(index) {
    const target = Math.max(0, Math.min(this.blocks.length - 1, index));
    if (!this.running) { this.i = target; this.ui.focus(target); return; }
    this.jumpTo = target;
    this.ctrl?.abort();
  }
  next() { this.goTo(this.i + 1); }
  // Volta para a última deixa (fala de outro personagem) antes da posição atual.
  repeatCue() {
    let k = this.i - 1;
    while (k > 0 && !(this.blocks[k].type === 'speech' && !this.isMine(this.blocks[k]))) k--;
    this.goTo(k);
  }
  stop() {
    this.pause();
    this.meter?.stop();
    this.meter = null;
  }
}

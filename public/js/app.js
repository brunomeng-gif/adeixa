import { parsePdfPages, parsePlainText, charactersOf } from './parser.js';
import { extractPdfPages } from './pdf-extract.js';
import * as store from './storage.js';
import { portugueseVoices, defaultVoiceConfig, speak, loadVoices, unlockAudio, keepScreenOn, genderOfVoice, guessGender, setGender } from './voices.js';
import { recognitionSupported, normalize, compare } from './speech.js';
import { emptyStats, expectationFor, learn } from './rhythm.js';
import { Rehearsal } from './rehearsal.js';

const $view = document.getElementById('view');
const DEBUG = new URLSearchParams(location.search).has('debug');
const $crumb = document.getElementById('crumb');
const state = { script: null, rehearsal: null };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? vals[i] : ''), '');

function toast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.saveScript(state.script), 400);
}

function scenesOf(blocks) {
  const scenes = [];
  blocks.forEach((b, i) => { if (b.type === 'scene') scenes.push({ index: i, title: b.text }); });
  if (!scenes.length) scenes.push({ index: 0, title: 'Peça inteira' });
  return scenes;
}

function go(view, ...args) {
  if (state.rehearsal) { state.rehearsal.stop(); state.rehearsal = null; keepScreenOn(false); }
  window.scrollTo(0, 0);
  views[view](...args);
}

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); go(nav.dataset.nav); }
});

// ---------------------------------------------------------------------------
// Início: lista de peças e importação
// ---------------------------------------------------------------------------
async function viewHome() {
  state.script = null;
  $crumb.textContent = '';
  const scripts = (await store.listScripts()).sort((a, b) => b.updatedAt - a.updatedAt);
  $view.innerHTML = html`
    <section class="card">
      <h1>Ensaie seu texto com os outros personagens</h1>
      <p class="muted">Suba a peça (PDF ou texto com o nome do personagem antes de cada fala), escolha seu papel e o app dá as deixas.</p>
      <label class="drop" id="drop">
        <input type="file" id="file" accept=".pdf,.txt,text/plain,application/pdf" hidden>
        <strong>Escolher arquivo da peça</strong>
        <span class="muted">ou arraste o PDF/TXT para cá</span>
      </label>
      <details>
        <summary>Ou colar o texto</summary>
        <textarea id="paste" rows="8" placeholder="GAEL: Amigo, o Terminal Jalapemba passa aqui?&#10;BERNARDO: Não faço ideia."></textarea>
        <input id="pasteTitle" placeholder="Título da peça">
        <button class="btn" id="pasteGo">Importar texto</button>
      </details>
      <p id="status" class="muted"></p>
    </section>
    ${scripts.length ? html`
    <section class="card">
      <h2>Suas peças</h2>
      <ul class="list">
        ${scripts.map(s => html`
          <li>
            <div><strong>${esc(s.title)}</strong>
              <div class="muted small">${charactersOf(s.blocks).length} personagens · ${s.blocks.filter(b => b.type === 'speech').length} falas</div></div>
            <div class="row">
              <button class="btn primary" data-open="${s.id}">Ensaiar</button>
              <button class="btn" data-review="${s.id}">Revisar texto</button>
              <button class="btn ghost" data-del="${s.id}" title="Apagar">🗑</button>
            </div>
          </li>`).join('')}
      </ul>
    </section>` : ''}
    ${browserNotes()}
  `;

  const status = document.getElementById('status');
  const handle = async file => {
    if (!file) return;
    status.textContent = 'Lendo o arquivo…';
    try {
      const title = file.name.replace(/\.[^.]+$/, '');
      const blocks = /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
        ? await parsePdf(await file.arrayBuffer())
        : parsePlainText(await file.text());
      await createScript(title, blocks);
    } catch (err) {
      console.error(err);
      status.textContent = 'Não consegui ler esse arquivo: ' + err.message;
    }
  };
  document.getElementById('file').onchange = e => handle(e.target.files[0]);
  const drop = document.getElementById('drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); };
  document.getElementById('pasteGo').onclick = () => {
    const text = document.getElementById('paste').value;
    if (!text.trim()) return;
    createScript(document.getElementById('pasteTitle').value || 'Peça sem título', parsePlainText(text));
  };
  $view.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => { state.script = await store.getScript(b.dataset.open); go('setup'); });
  $view.querySelectorAll('[data-review]').forEach(b => b.onclick = async () => { state.script = await store.getScript(b.dataset.review); go('review'); });
  $view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Apagar esta peça e todas as gravações dela?')) return;
    await store.deleteScript(b.dataset.del);
    viewHome();
  });
}

function browserNotes() {
  const notes = [];
  if (!recognitionSupported) notes.push('Este navegador não reconhece fala: use Chrome ou Edge para o app ouvir você. Sem isso, você avança com a barra de espaço.');
  if (!window.speechSynthesis) notes.push('Este navegador não tem vozes sintéticas.');
  return notes.length ? `<section class="card warn">${notes.map(n => `<p>${esc(n)}</p>`).join('')}</section>` : '';
}

async function parsePdf(buffer) {
  // Caminhos relativos, para funcionar também publicado numa subpasta (GitHub Pages).
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  return parsePdfPages(await extractPdfPages(pdfjs, new Uint8Array(buffer)));
}

async function createScript(title, blocks) {
  if (!blocks.some(b => b.type === 'speech')) {
    toast('Não encontrei falas. O formato esperado é o NOME do personagem antes de cada fala.');
    return;
  }
  state.script = {
    id: crypto.randomUUID(),
    title,
    blocks,
    voices: {},
    settings: { mine: [], display: 'initials', readDirections: false, autoListen: true, rate: 1, pauseMs: 300, scene: 0, sceneTo: null },
    createdAt: Date.now(),
  };
  await store.saveScript(state.script);
  go('review');
}

// ---------------------------------------------------------------------------
// Revisão: conferir personagens e falas
// ---------------------------------------------------------------------------
function viewReview() {
  const s = state.script;
  $crumb.textContent = s.title + ' · revisão';
  const chars = charactersOf(s.blocks);
  const options = chars.map(c => `<option>${esc(c.name)}</option>`).join('');
  $view.innerHTML = html`
    <section class="card">
      <h1>Confira o texto</h1>
      <p class="muted">Veja se cada fala ficou com o personagem certo. Para juntar dois nomes (ex.: um erro de digitação), renomeie um igual ao outro.</p>
      <label>Título <input id="title" value="${esc(s.title)}"></label>
      <h3>Personagens</h3>
      <div class="chars">
        ${chars.map(c => html`
          <label class="char"><input data-rename="${esc(c.name)}" value="${esc(c.name)}"><span class="muted small">${c.lines} falas</span></label>`).join('')}
      </div>
      <div class="row"><button class="btn primary" data-nav="setup">Pronto, ir para o ensaio →</button></div>
    </section>
    <section class="card script">
      ${s.blocks.map((b, i) => blockEditor(b, i, options)).join('')}
    </section>
  `;
  document.getElementById('title').onchange = e => { s.title = e.target.value; saveSoon(); };
  $view.querySelectorAll('[data-rename]').forEach(inp => inp.onchange = () => {
    const from = inp.dataset.rename, to = inp.value.trim().toUpperCase();
    if (!to || to === from) return;
    s.blocks.forEach(b => { if (b.character === from) b.character = to; });
    s.settings.mine = s.settings.mine.map(m => (m === from ? to : m));
    saveSoon();
    viewReview();
  });
  $view.querySelectorAll('[data-char]').forEach(sel => sel.onchange = () => {
    s.blocks[sel.dataset.char].character = sel.value;
    saveSoon();
  });
  $view.querySelectorAll('[data-text]').forEach(el => el.onblur = () => {
    const b = s.blocks[el.dataset.text];
    const text = el.innerText.replace(/\s+/g, ' ').trim();
    if (text === b.text) return;
    b.text = text;
    if (b.type === 'speech') b.spoken = text.replace(/\(([^()0-9]*)\)/g, ' ').replace(/\s+/g, ' ').trim();
    saveSoon();
  });
  $view.querySelectorAll('[data-del-block]').forEach(btn => btn.onclick = () => {
    s.blocks.splice(Number(btn.dataset.delBlock), 1);
    saveSoon();
    viewReview();
  });
  $view.querySelectorAll('[data-to-direction]').forEach(btn => btn.onclick = () => {
    const b = s.blocks[btn.dataset.toDirection];
    b.type = 'direction';
    delete b.character; delete b.spoken;
    saveSoon();
    viewReview();
  });
}

function blockEditor(b, i, options) {
  if (b.type === 'scene') return `<h2 class="scene" data-text="${i}" contenteditable>${esc(b.text)}</h2>`;
  const tools = `<span class="tools">${b.type === 'speech' ? `<button class="icon" data-to-direction="${i}" title="Transformar em rubrica">↧</button>` : ''}<button class="icon" data-del-block="${i}" title="Apagar">✕</button></span>`;
  if (b.type === 'direction') return `<div class="block direction"><div class="text" data-text="${i}" contenteditable>${esc(b.text)}</div>${tools}</div>`;
  const sel = `<select data-char="${i}">${options.replace(`<option>${esc(b.character)}</option>`, `<option selected>${esc(b.character)}</option>`)}</select>`;
  return `<div class="block speech">${sel}<div class="text" data-text="${i}" contenteditable>${esc(b.text)}</div>${tools}</div>`;
}

// ---------------------------------------------------------------------------
// Configurar ensaio: papel, cena, vozes
// ---------------------------------------------------------------------------
async function viewSetup() {
  const s = state.script;
  $crumb.textContent = s.title;
  const chars = charactersOf(s.blocks);
  const scenes = scenesOf(s.blocks);
  const voices = await portugueseVoices();
  const missing = chars.map(c => c.name).filter(n => !s.voices[n]);
  let changed = false;
  if (missing.length) {
    const defaults = defaultVoiceConfig([...Object.keys(s.voices), ...missing]);
    missing.forEach(n => { s.voices[n] = defaults[n]; });
    changed = true;
  }
  if (!s.voices.__narrador) { s.voices.__narrador = { gender: 'f', voiceURI: '', variant: 0, pitch: 1, rate: 1.1 }; changed = true; }
  // Peças antigas não tinham gênero: deduz pela voz que estava escolhida (ou pelo nome).
  for (const [name, cfg] of Object.entries(s.voices)) {
    if (cfg.gender) continue;
    cfg.gender = genderOfVoice(voices.find(v => v.voiceURI === cfg.voiceURI)) || guessGender(name);
    changed = true;
  }
  if (changed) saveSoon();
  const hasGender = g => voices.some(v => (genderOfVoice(v) ?? 'f') === g);
  const recs = await store.listRecordings(s.id);
  const recCount = name => recs.filter(r => r.character === name).length;
  const st = s.settings;
  const voiceLabel = v => `${v.name.replace(/^Microsoft /, '').replace(/ - Portuguese.*$/, '')} · ${/BR/i.test(v.lang) ? 'Brasil' : /PT/i.test(v.lang) ? 'Portugal' : v.lang}`;
  const voiceOptions = cfg => `<option value="" ${cfg.voiceURI ? '' : 'selected'}>Automática</option>` + voices
    .filter(v => (genderOfVoice(v) ?? 'f') === cfg.gender || v.voiceURI === cfg.voiceURI || !hasGender(cfg.gender))
    .map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === cfg.voiceURI ? 'selected' : ''}>${esc(voiceLabel(v))}</option>`).join('');
  const genderSelect = (name, cfg) => `<select data-gender="${esc(name)}" aria-label="Gênero da voz"><option value="f" ${cfg.gender === 'f' ? 'selected' : ''}>Feminina</option><option value="m" ${cfg.gender === 'm' ? 'selected' : ''}>Masculina</option></select>`;

  $view.innerHTML = html`
    <section class="card">
      <h1>${esc(s.title)}</h1>
      <h3>1. Qual é o seu papel?</h3>
      <div class="chips">
        ${chars.map(c => html`<label class="chip ${st.mine.includes(c.name) ? 'on' : ''}"><input type="checkbox" data-mine="${esc(c.name)}" ${st.mine.includes(c.name) ? 'checked' : ''}>${esc(c.name)} <span class="small">${c.lines}</span></label>`).join('')}
      </div>
      <h3>2. O que ensaiar?</h3>
      <div class="row wrap">
        <label>De <select id="scene">${scenes.map((sc, i) => `<option value="${i}" ${i === st.scene ? 'selected' : ''}>${esc(sc.title)}</option>`).join('')}</select></label>
        <label>até <select id="sceneTo">${scenes.map((sc, i) => `<option value="${i}" ${i === (st.sceneTo ?? st.scene) ? 'selected' : ''}>${esc(sc.title)}</option>`).join('')}</select></label>
      </div>
      <h3>3. Como mostrar as suas falas?</h3>
      <div class="row wrap">
        ${[['hidden', 'Escondidas'], ['initials', 'Só as iniciais'], ['full', 'Texto completo']].map(([v, l]) => `<label class="radio"><input type="radio" name="display" value="${v}" ${st.display === v ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
      <h3>4. Opções</h3>
      <label class="check"><input type="checkbox" id="autoListen" ${st.autoListen ? 'checked' : ''} ${recognitionSupported ? '' : 'disabled'}> Ouvir minha voz e dar a deixa sozinho ${recognitionSupported ? '' : '<span class="muted small">(indisponível neste navegador)</span>'}</label>
      <label class="check"><input type="checkbox" id="readDirections" ${st.readDirections ? 'checked' : ''}> Ler as rubricas em voz alta</label>
      ${speedControls(st)}
      ${rhythmInfo(s)}
      <div class="row"><button class="btn primary big" id="go">▶ Começar ensaio</button></div>
      <p class="muted small">Dica: use fone de ouvido. Diga <b>"texto"</b> quando esquecer a fala e o app mostra o ponto.</p>
    </section>

    <section class="card">
      <h2>Vozes dos personagens</h2>
      <p class="muted small">Falas gravadas pelo elenco têm prioridade sobre a voz sintética.</p>
      <table class="voices">
        ${[...chars.map(c => c.name), '__narrador'].map(name => {
          const cfg = s.voices[name];
          const label = name === '__narrador' ? '<em>Rubricas</em>' : esc(name);
          return html`<tr>
            <td><strong>${label}</strong>${name !== '__narrador' ? `<div class="small muted">${recCount(name)} de ${chars.find(c => c.name === name).lines} gravadas</div>` : ''}</td>
            <td>${genderSelect(name, cfg)}</td>
            <td><select data-voice="${esc(name)}" aria-label="Voz">${voiceOptions(cfg)}</select></td>
            <td><label class="small">tom <input type="range" min="0.5" max="1.6" step="0.05" value="${cfg.pitch}" data-pitch="${esc(name)}"></label></td>
            <td class="row"><button class="btn small-btn" data-test="${esc(name)}">Ouvir</button>${name !== '__narrador' ? `<button class="btn small-btn" data-record="${esc(name)}">🎙 Gravar falas</button>` : ''}</td>
          </tr>`;
        }).join('')}
      </table>
      ${voices.length ? '' : '<p class="warn">Nenhuma voz sintética encontrada neste navegador.</p>'}
      ${voices.length && !(hasGender('m') && hasGender('f')) ? `<p class="muted small">Este aparelho só tem voz ${hasGender('m') ? 'masculina' : 'feminina'} em português. As vozes ${hasGender('m') ? 'femininas' : 'masculinas'} usam essa mesma voz com o tom ajustado.</p>` : ''}
      <div class="row">
        <button class="btn" id="exportRec">Exportar gravações</button>
        <label class="btn">Importar gravações<input type="file" id="importRec" accept=".json" hidden></label>
        <button class="btn ghost" data-nav="review">Revisar texto</button>
      </div>
    </section>
  `;

  $view.querySelectorAll('[data-mine]').forEach(cb => cb.onchange = () => {
    st.mine = [...$view.querySelectorAll('[data-mine]:checked')].map(x => x.dataset.mine);
    cb.closest('.chip').classList.toggle('on', cb.checked);
    saveSoon();
  });
  const sceneSel = document.getElementById('scene'), sceneTo = document.getElementById('sceneTo');
  sceneSel.onchange = () => { st.scene = +sceneSel.value; if ((st.sceneTo ?? 0) < st.scene) { st.sceneTo = st.scene; sceneTo.value = st.scene; } saveSoon(); };
  sceneTo.onchange = () => { st.sceneTo = Math.max(+sceneTo.value, st.scene); saveSoon(); };
  $view.querySelectorAll('[name=display]').forEach(r => r.onchange = () => { st.display = r.value; saveSoon(); });
  document.getElementById('autoListen').onchange = e => { st.autoListen = e.target.checked; saveSoon(); };
  document.getElementById('readDirections').onchange = e => { st.readDirections = e.target.checked; saveSoon(); };
  bindSpeedControls(st);
  const forget = document.getElementById('forgetRhythm');
  if (forget) forget.onclick = () => { s.rhythm = emptyStats(); saveSoon(); viewSetup(); };
  $view.querySelectorAll('[data-voice]').forEach(sel => sel.onchange = () => { s.voices[sel.dataset.voice].voiceURI = sel.value; saveSoon(); });
  $view.querySelectorAll('[data-gender]').forEach(sel => sel.onchange = () => {
    // Volta para "Automática", que escolhe uma voz do gênero novo, com tom próprio.
    setGender(s.voices, sel.dataset.gender, sel.value);
    saveSoon();
    const y = window.scrollY;
    viewSetup().then(() => window.scrollTo(0, y));
  });
  $view.querySelectorAll('[data-pitch]').forEach(r => r.onchange = () => { s.voices[r.dataset.pitch].pitch = +r.value; saveSoon(); });
  $view.querySelectorAll('[data-test]').forEach(b => b.onclick = () => {
    const name = b.dataset.test;
    const sample = name === '__narrador'
      ? (s.blocks.find(x => x.type === 'direction')?.text || 'Rubrica de exemplo.')
      : (s.blocks.find(x => x.character === name)?.spoken || 'Olá.');
    speak(sample.slice(0, 160), s.voices[name]);
  });
  $view.querySelectorAll('[data-record]').forEach(b => b.onclick = () => go('record', b.dataset.record));
  document.getElementById('exportRec').onclick = exportRecordings;
  document.getElementById('importRec').onchange = e => importRecordings(e.target.files[0]);
  document.getElementById('go').onclick = () => {
    if (!st.mine.length) { toast('Escolha pelo menos um personagem seu.'); return; }
    unlockAudio(); // precisa acontecer dentro do toque, antes de qualquer espera
    go('rehearse');
  };
}

// ---------------------------------------------------------------------------
// Gravar falas com a voz do ator real
// ---------------------------------------------------------------------------
async function viewRecord(character) {
  const s = state.script;
  $crumb.textContent = `${s.title} · gravações de ${character}`;
  const lines = s.blocks.map((b, i) => ({ b, i })).filter(x => x.b.type === 'speech' && x.b.character === character);
  const recs = new Map((await store.listRecordings(s.id)).map(r => [r.blockId, r]));
  const cueFor = i => {
    for (let k = i - 1; k >= 0 && s.blocks[k].type !== 'scene'; k--) {
      if (s.blocks[k].type === 'speech' && s.blocks[k].character !== character) return s.blocks[k];
    }
    return null;
  };

  $view.innerHTML = html`
    <section class="card">
      <h1>Gravar as falas de ${esc(character)}</h1>
      <p class="muted">A pessoa que faz ${esc(character)} grava cada fala aqui. No ensaio, os colegas ouvem essa gravação no lugar da voz sintética. Para mandar para o elenco, use "Exportar gravações" na tela anterior.</p>
      <p class="muted small">${recs.size ? [...recs.values()].filter(r => r.character === character).length : 0} de ${lines.length} gravadas.</p>
      <button class="btn" data-nav="setup">← Voltar</button>
    </section>
    <section class="card">
      ${lines.map(({ b, i }) => {
        const cue = cueFor(i);
        return html`<div class="rec-line" id="rl-${b.id}">
          ${cue ? `<div class="cue small muted">${esc(cue.character)}: …${esc(cue.text.slice(-90))}</div>` : ''}
          <div class="text">${esc(b.text)}</div>
          <div class="row">
            <button class="btn" data-rec="${b.id}">● Gravar</button>
            <button class="btn" data-play="${b.id}" ${recs.has(b.id) ? '' : 'disabled'}>▶ Ouvir</button>
            <button class="btn ghost" data-delrec="${b.id}" ${recs.has(b.id) ? '' : 'disabled'}>Apagar</button>
            <span class="small ${recs.has(b.id) ? 'ok' : 'muted'}">${recs.has(b.id) ? '✓ gravada' : 'sem gravação'}</span>
          </div>
        </div>`;
      }).join('')}
    </section>
  `;

  let recorder = null;
  $view.querySelectorAll('[data-rec]').forEach(btn => btn.onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { toast('Sem acesso ao microfone.'); return; }
    const block = s.blocks.find(x => x.id === btn.dataset.rec);
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      recorder = null;
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      await store.saveRecording({ scriptId: s.id, blockId: block.id, character, text: block.text, blob });
      const y = window.scrollY;
      await viewRecord(character);
      window.scrollTo(0, y);
    };
    recorder.start();
    btn.textContent = '■ Parar';
    btn.classList.add('recording');
  });
  $view.querySelectorAll('[data-play]').forEach(btn => btn.onclick = () => {
    const r = recs.get(btn.dataset.play);
    if (r) new Audio(URL.createObjectURL(r.blob)).play();
  });
  $view.querySelectorAll('[data-delrec]').forEach(btn => btn.onclick = async () => {
    await store.deleteRecording(s.id, btn.dataset.delrec);
    const y = window.scrollY;
    await viewRecord(character);
    window.scrollTo(0, y);
  });
}

const blobToDataUrl = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });

async function exportRecordings() {
  const s = state.script;
  const recs = await store.listRecordings(s.id);
  if (!recs.length) { toast('Ainda não há gravações nesta peça.'); return; }
  const pack = {
    app: 'adeixa', version: 1, title: s.title,
    recordings: await Promise.all(recs.map(async r => ({ blockId: r.blockId, character: r.character, text: r.text, audio: await blobToDataUrl(r.blob) }))),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(pack)], { type: 'application/json' }));
  a.download = `${s.title} - gravações.json`;
  a.click();
}

async function importRecordings(file) {
  if (!file) return;
  const s = state.script;
  try {
    const pack = JSON.parse(await file.text());
    let ok = 0;
    for (const r of pack.recordings || []) {
      // Procura a mesma fala pelo personagem + texto (o id pode mudar entre importações).
      const key = normalize(r.text);
      const block = s.blocks.find(b => b.type === 'speech' && b.character === r.character && normalize(b.text) === key)
        || s.blocks.find(b => b.id === r.blockId && b.type === 'speech');
      if (!block) continue;
      const blob = await (await fetch(r.audio)).blob();
      await store.saveRecording({ scriptId: s.id, blockId: block.id, character: block.character, text: block.text, blob });
      ok++;
    }
    toast(`${ok} gravações importadas.`);
    viewSetup();
  } catch (err) {
    toast('Arquivo de gravações inválido.');
  }
}

// ---------------------------------------------------------------------------
// Ensaio
// ---------------------------------------------------------------------------
async function viewRehearse() {
  const s = state.script, st = s.settings;
  const scenes = scenesOf(s.blocks);
  const from = scenes[st.scene]?.index ?? 0;
  const toScene = scenes[(st.sceneTo ?? st.scene) + 1];
  const blocks = s.blocks.slice(from, toScene ? toScene.index : s.blocks.length);
  const mine = new Set(st.mine);
  const isMine = b => b.type === 'speech' && mine.has(b.character);
  const recs = new Map((await store.listRecordings(s.id)).map(r => [r.blockId, r]));
  await loadVoices();

  $crumb.textContent = `${s.title} · ensaio`;
  $view.innerHTML = html`
    <section class="stage" id="stage">
      ${blocks.map((b, i) => renderStageBlock(b, i, isMine(b), st.display)).join('')}
      <div id="summary"></div>
    </section>
    <div class="controls">
      <div class="heard" id="heard"><span class="muted">${st.autoListen && recognitionSupported ? 'O app vai ouvir você na sua vez.' : 'Na sua vez, fale e aperte "Próxima" (ou espaço).'}</span></div>
      <div class="row center">
        <button class="btn" id="back" title="Voltar para a deixa anterior">⟲ Deixa</button>
        <button class="btn primary" id="play">⏸ Pausar</button>
        <button class="btn" id="hint" title="Mostrar o ponto">💡 Texto</button>
        <button class="btn" id="next" title="Próxima (espaço)">Próxima ⏭</button>
        <button class="btn ghost" data-nav="setup">Sair</button>
      </div>
      <div class="speeds">${speedControls(st)}</div>
    </div>
  `;

  const $heard = document.getElementById('heard');
  const $play = document.getElementById('play');
  let currentMine = null, revealed = 0, lastResult = null;

  const ui = {
    state(s) {
      $play.textContent = s === 'playing' ? '⏸ Pausar' : s === 'finished' ? '↺ De novo' : '▶ Continuar';
      $play.dataset.state = s;
      keepScreenOn(s === 'playing');
    },
    focus(i) {
      $view.querySelectorAll('.sb.current').forEach(el => el.classList.remove('current'));
      const el = document.getElementById('sb-' + i);
      el?.classList.add('current');
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      currentMine = isMine(blocks[i]) ? i : null;
      revealed = 0; lastResult = null;
      if (currentMine === null) $heard.innerHTML = `<span class="muted">${blocks[i].type === 'speech' ? esc(blocks[i].character) + ' falando…' : ''}</span>`;
    },
    waitingForMe() { $heard.innerHTML = '<span class="you">🎙 Sua vez</span>'; },
    heard(transcript, result) {
      lastResult = result; // usado só para saber de onde dar o ponto
      $heard.innerHTML = '<span class="you">🎙 Ouvindo…</span>';
    },
    prompt() { showHint(); },
    notice(msg) { toast(msg, 6000); },
    // Diagnóstico (abrir o app com ?debug no endereço): mostra de onde vem o atraso.
    timing: DEBUG ? t => {
      const { voiceEnd, textEnd, finishedAt } = t.timing;
      const end = voiceEnd || textEnd;
      const via = { complete: 'texto completo', voice: 'volume', silence: 'silêncio longo' }[t.reason] || t.reason;
      const exp = t.expectation?.expectedVoiceMs;
      toast(`fim da fala → deixa: ${t.cueStart - end} ms · decidiu em ${finishedAt - end} ms (${via}) · voz começou ${t.cueStart - finishedAt} ms depois · medidor ${voiceEnd ? 'ok' : 'sem som'} · voz ${t.voicedMs ?? '?'} de ${exp ? Math.round(exp) : '?'} ms esperados (${t.expectation?.source ?? '?'})`, 7000);
    } : null,
    finished() {
      document.getElementById('summary').innerHTML = '<div class="card done"><h2>Fim do trecho 👏</h2></div>';
      document.getElementById('summary').scrollIntoView({ behavior: 'smooth' });
    },
  };

  function showHint() {
    if (currentMine === null) return;
    const b = blocks[currentMine];
    const words = (b.spoken || b.text).split(/\s+/);
    const start = lastResult && lastResult.nextMissing > 0 ? lastResult.nextMissing : 0;
    revealed = Math.max(revealed, start) + 3;
    const el = document.querySelector(`#sb-${currentMine} .line`);
    if (el) el.innerHTML = esc(words.slice(0, revealed).join(' ')) + (revealed < words.length ? ' <span class="muted">…</span>' : '');
  }

  const r = state.rehearsal = new Rehearsal({
    blocks,
    isMine,
    voiceFor: name => s.voices[name] || {},
    narratorVoice: s.voices.__narrador,
    recordingFor: b => recs.get(b.id),
    readDirections: st.readDirections,
    autoListen: st.autoListen,
    rate: st.rate,
    pauseMs: st.pauseMs ?? 300,
    rhythm: rhythmFor(s),
    ui,
  });

  $play.onclick = () => {
    if ($play.dataset.state !== 'playing') unlockAudio();
    if ($play.dataset.state === 'playing') r.pause();
    else if ($play.dataset.state === 'finished') { document.getElementById('summary').innerHTML = ''; r.start(0); }
    else r.resume();
  };
  document.getElementById('next').onclick = () => r.next();
  document.getElementById('back').onclick = () => r.repeatCue();
  document.getElementById('hint').onclick = showHint;
  // Mudanças de velocidade valem a partir da próxima fala.
  bindSpeedControls(st, () => { r.rate = st.rate; r.pauseMs = st.pauseMs; });
  $view.querySelectorAll('.sb').forEach(el => el.ondblclick = () => r.goTo(Number(el.dataset.i)));
  const onKey = e => {
    if (!document.getElementById('stage')) { document.removeEventListener('keydown', onKey); return; }
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); r.next(); }
  };
  document.addEventListener('keydown', onKey);
  r.start(0);
}

// Velocidade das deixas e tempo de resposta (aparecem na configuração e no ensaio).
function speedControls(st) {
  const pause = st.pauseMs ?? 300;
  return html`
    <label class="speed">Velocidade das deixas <input type="range" data-speed="rate" min="0.7" max="1.6" step="0.05" value="${st.rate}"> <span data-val="rate">${fmtRate(st.rate)}</span></label>
    <label class="speed">Tempo de resposta <input type="range" data-speed="pauseMs" min="0" max="1500" step="50" value="${pause}"> <span data-val="pauseMs">${fmtPause(pause)}</span></label>`;
}
const fmtRate = v => v.toFixed(2).replace(/0$/, '').replace('.', ',') + '×';
const fmtPause = v => v === 0 ? 'imediato' : (v / 1000).toFixed(2).replace(/0$/, '').replace('.', ',') + ' s';

function bindSpeedControls(st, onChange) {
  $view.querySelectorAll('[data-speed]').forEach(inp => inp.oninput = () => {
    const key = inp.dataset.speed;
    st[key] = Number(inp.value);
    $view.querySelectorAll(`[data-val="${key}"]`).forEach(el => { el.textContent = key === 'rate' ? fmtRate(st[key]) : fmtPause(st[key]); });
    $view.querySelectorAll(`[data-speed="${key}"]`).forEach(other => { if (other !== inp) other.value = inp.value; });
    onChange?.();
    saveSoon();
  });
}

function rhythmInfo(script) {
  const r = script.rhythm;
  const n = r ? Object.keys(r.lines).length : 0;
  if (!n) return '<p class="small muted">O app aprende o seu ritmo durante os ensaios. Isso deixa as deixas mais certeiras, principalmente no Android.</p>';
  return `<p class="small muted">Ritmo aprendido em ${n} ${n === 1 ? 'fala' : 'falas'}${r.msPerWord ? ` (cerca de ${(r.msPerWord / 1000).toFixed(2).replace('.', ',')} s de voz por palavra)` : ''}. <button class="btn small-btn ghost" id="forgetRhythm">Esquecer ritmo</button></p>`;
}

// Ritmo aprendido do ator nesta peça (fica salvo junto com a peça, neste aparelho).
function rhythmFor(script) {
  script.rhythm ||= emptyStats();
  const words = b => compare(b.spoken || b.text, '').words.length;
  let backup = null;
  return {
    expect: b => expectationFor(script.rhythm, b.id, words(b)),
    learn(b, out) {
      const before = JSON.stringify(script.rhythm);
      if (learn(script.rhythm, b.id, words(b), out)) { backup = before; saveSoon(); }
    },
    undo() {
      if (!backup) return;
      script.rhythm = JSON.parse(backup);
      backup = null;
      saveSoon();
    },
  };
}

const initials = w => w.replace(/(\p{L})\p{L}*/gu, '$1');

function renderStageBlock(b, i, mine, display) {
  if (b.type === 'scene') return `<h2 class="sb scene" id="sb-${i}" data-i="${i}">${esc(b.text)}</h2>`;
  if (b.type === 'direction') return `<div class="sb direction" id="sb-${i}" data-i="${i}">${esc(b.text)}</div>`;
  let line = esc(b.text);
  if (mine && display === 'hidden') line = '<span class="muted">(sua fala)</span>';
  if (mine && display === 'initials') line = esc(initials(b.text));
  return html`<div class="sb speech ${mine ? 'mine' : ''}" id="sb-${i}" data-i="${i}">
    <div class="who">${esc(b.character)}</div>
    <div class="line">${line}</div>
  </div>`;
}

const views = { home: viewHome, review: viewReview, setup: viewSetup, record: viewRecord, rehearse: viewRehearse };
viewHome();

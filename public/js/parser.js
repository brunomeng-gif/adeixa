// Converte o texto de uma peça em blocos estruturados:
//   { id, type: 'scene' | 'speech' | 'direction', character?, text, spoken? }
// `text` é o que aparece na tela; `spoken` é o que deve ser dito em voz alta
// (sem as rubricas entre parênteses).

// Cabeçalhos: "CENA 2", "ATO I", "Cena 3", "PRÓLOGO"… (sem confundir com "ato de violência")
const SCENE_RE = /^(?:(?:CENA|ATO|QUADRO|PR[ÓO]LOGO|EP[ÍI]LOGO)(?![A-Za-zÀ-ÿ])|(?:Cena|Ato|Quadro)\s+(?:\d+|[IVXLC]+\b|final|[úu]nic[oa]))/u;
const NAME_RE = /^[A-ZÀ-ÖØ-Ý0-9][A-ZÀ-ÖØ-Ý0-9 .'’\-]*$/u;

export function isNameLike(s) {
  const t = cleanName(s);
  return t.length >= 2 && t.length <= 40 && NAME_RE.test(t) && /[A-ZÀ-Ý]/u.test(t);
}

export function cleanName(s) {
  return s.replace(/\s+/g, ' ').replace(/[:.\s]+$/, '').trim();
}

// ---------------------------------------------------------------------------
// PDF: recebe as páginas com itens posicionados (ver pdf-extract.js)
// ---------------------------------------------------------------------------

export function parsePdfPages(pages) {
  const pageLines = pages.map(p => groupLines(p.items));
  const layout = detectColumns(pageLines);
  if (!layout) {
    // Sem coluna de nomes: trata como texto corrido ("NOME: fala").
    const text = pageLines.map(lines => lines.map(l => joinItems(l.items)).join('\n')).join('\n\n');
    return parsePlainText(text);
  }

  const blocks = [];
  let current = null; // bloco em construção
  let lastY = null;

  pageLines.forEach(lines => {
    const dialogueFont = pageDialogueFont(lines, layout.boundary);
    lines.forEach((line, idx) => {
      const inNameColumn = line.items[0].x < layout.nameX + 15;
      const nameItems = inNameColumn ? line.items.filter(it => it.x < layout.boundary) : [];
      const bodyItems = inNameColumn ? line.items.filter(it => it.x >= layout.boundary) : line.items;
      const nameText = joinItems(nameItems);
      const gap = idx === 0 || lastY === null ? null : lastY - line.y;
      lastY = line.y;

      if (nameItems.length && bodyItems.length && isNameLike(nameText)) {
        const { text, spoken } = bodyText(bodyItems, dialogueFont);
        current = { type: 'speech', character: cleanName(nameText), text, spoken };
        blocks.push(current);
        return;
      }

      const full = joinItems(line.items);
      if (!full || /^\d+$/.test(full)) return; // número de página
      if (SCENE_RE.test(full) && full.length < 40) {
        current = { type: 'scene', text: full.replace(/\s+/g, ' ') };
        blocks.push(current);
        return;
      }
      // Nome sozinho na linha (fala começa na linha de baixo)
      if (nameItems.length && !bodyItems.length && isNameLike(nameText)) {
        current = { type: 'speech', character: cleanName(nameText), text: '', spoken: '' };
        blocks.push(current);
        return;
      }

      const font = dominantFont(line.items);
      const closeToPrevious = gap !== null ? gap <= layout.lineGap * 1.6 : font === dialogueFont;
      if (current && current.type === 'speech' && (closeToPrevious || !current.text)) {
        const { text, spoken } = bodyText(line.items, dialogueFont);
        current.text = joinText(current.text, text);
        current.spoken = joinText(current.spoken, spoken);
      } else if (current && current.type === 'direction' && gap !== null && gap <= layout.lineGap * 1.6) {
        current.text = joinText(current.text, full);
      } else {
        current = { type: 'direction', text: full };
        blocks.push(current);
      }
    });
  });

  return finalize(blocks);
}

function groupLines(items) {
  const lines = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const tol = Math.max(2, (it.h || 10) * 0.3);
    let line = lines.find(l => Math.abs(l.y - it.y) < tol);
    if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
    line.items.push(it);
  }
  lines.sort((a, b) => b.y - a.y);
  lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
  return lines;
}

// Junta os pedaços de texto de uma linha, decidindo se há espaço entre eles
// pela distância horizontal (o pdf.js costuma quebrar palavras no meio).
export function joinItems(items) {
  let out = '';
  let prev = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > (it.h || 10) * 0.12 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
    }
    out += it.str;
    prev = it;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Encontra a coluna dos nomes (à esquerda) e onde começa a coluna das falas.
function detectColumns(pageLines) {
  const nameX = {}, bodyX = {}, gaps = {};
  pageLines.forEach(lines => {
    lines.forEach((line, i) => {
      const first = line.items[0];
      const rest = line.items.filter(it => it.x > first.x + first.w + 15);
      if (!rest.length) return;
      const nameText = joinItems(line.items.filter(it => it.x < rest[0].x));
      if (!isNameLike(nameText)) return;
      inc(nameX, Math.round(first.x));
      inc(bodyX, Math.round(rest[0].x));
      if (i > 0) inc(gaps, Math.round(lines[i - 1].y - line.y));
    });
  });
  const nx = mode(nameX), bx = mode(bodyX);
  if (nx === null || bx === null || (nameX[nx] || 0) < 5) return null;
  return { nameX: nx, bodyX: bx, boundary: bx - 5, lineGap: mode(gaps) || 16 };
}

function pageDialogueFont(lines, boundary) {
  const fonts = {};
  for (const line of lines) {
    if (!line.items.some(it => it.x < boundary)) continue;
    for (const it of line.items) if (it.x >= boundary) inc(fonts, it.font, it.str.length);
  }
  return mode(fonts);
}

function dominantFont(items) {
  const fonts = {};
  for (const it of items) inc(fonts, it.font, it.str.length);
  return mode(fonts);
}

// Monta o texto da fala. Trechos entre parênteses em fonte diferente da fala
// (rubricas, geralmente em itálico) ficam na tela mas não são falados.
function bodyText(items, dialogueFont) {
  let text = '', spoken = '', prev = null, inStage = false;
  for (const it of items) {
    const s = it.str;
    let sep = '';
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > (it.h || 10) * 0.12 && !/\s$/.test(s) && !/^\s/.test(s)) sep = ' ';
    }
    if (!inStage && s.trim().startsWith('(') && dialogueFont && it.font !== dialogueFont) inStage = true;
    text += sep + s;
    if (!inStage) spoken += sep + s;
    if (inStage && s.trim().endsWith(')')) inStage = false;
    prev = it;
  }
  return { text: tidy(text), spoken: tidy(spoken) };
}

// ---------------------------------------------------------------------------
// Texto puro: "NOME: fala", "NOME  fala" ou o nome sozinho na linha de cima.
// ---------------------------------------------------------------------------

export function parsePlainText(raw) {
  const blocks = [];
  let current = null;
  const lines = raw.replace(/\r/g, '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { if (current && current.type !== 'speech') current = null; else if (current) current.closed = true; continue; }
    if (/^\d+$/.test(line)) continue;
    if (SCENE_RE.test(line) && line.length < 40) {
      current = { type: 'scene', text: line };
      blocks.push(current);
      continue;
    }
    const m = line.match(/^([^:\-–—]{2,40}?)\s*[:\-–—]\s+(.+)$/) || line.match(/^(\S.{1,39}?)\s{2,}(.+)$/);
    if (m && isNameLike(m[1])) {
      current = { type: 'speech', character: cleanName(m[1]), text: m[2], spoken: stripStage(m[2]) };
      blocks.push(current);
      continue;
    }
    if (isNameLike(line) && line === line.toUpperCase() && line.split(' ').length <= 4) {
      current = { type: 'speech', character: cleanName(line), text: '', spoken: '' };
      blocks.push(current);
      continue;
    }
    if (current && current.type === 'speech' && (!current.closed || !current.text)) {
      current.text = joinText(current.text, line);
      current.spoken = joinText(current.spoken, stripStage(line));
    } else if (current && current.type === 'direction') {
      current.text = joinText(current.text, line);
    } else {
      current = { type: 'direction', text: line };
      blocks.push(current);
    }
  }
  blocks.forEach(b => delete b.closed);
  return finalize(blocks);
}

// Remove rubricas entre parênteses que não contêm números (ex.: "(fumando)").
export function stripStage(s) {
  return tidy(s.replace(/\(([^()0-9]*)\)/g, ' '));
}

// ---------------------------------------------------------------------------

function finalize(blocks) {
  // Descarta o que vem antes da primeira cena (capa, epígrafe), se houver cenas.
  const firstScene = blocks.findIndex(b => b.type === 'scene');
  const firstSpeech = blocks.findIndex(b => b.type === 'speech');
  let list = firstScene >= 0 && firstScene <= firstSpeech ? blocks.slice(firstScene) : blocks;
  list = list.filter(b => b.text || b.type === 'speech');
  return list.map((b, i) => ({ id: 'b' + (i + 1), ...b }));
}

export function charactersOf(blocks) {
  const counts = new Map();
  for (const b of blocks) if (b.type === 'speech') counts.set(b.character, (counts.get(b.character) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, lines]) => ({ name, lines }));
}

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  // palavra hifenizada no fim da linha
  if (/[A-Za-zÀ-ÿ]-$/.test(a) && /^[a-zà-ÿ]/.test(b)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}

function tidy(s) {
  return s.replace(/\s+/g, ' ').replace(/\s+([,.!?;:…])/g, '$1').trim();
}

function inc(obj, key, by = 1) { if (key != null) obj[key] = (obj[key] || 0) + by; }
function mode(obj) {
  let best = null, n = -1;
  for (const [k, v] of Object.entries(obj)) if (v > n) { best = k; n = v; }
  return best === null ? null : (isNaN(best) ? best : Number(best));
}

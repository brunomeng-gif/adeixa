// Roda o separador de falas num PDF e mostra um resumo.
// Uso: node test/parse-pdf.mjs [arquivo.pdf] [--all]
import fs from 'fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPages } from '../public/js/pdf-extract.js';
import { parsePdfPages, charactersOf } from '../public/js/parser.js';

const file = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'A CULPA É DOS JAVALIS vFinal - Biagio Pecorelli.pdf';
const pages = await extractPdfPages(pdfjs, new Uint8Array(fs.readFileSync(file)));
const blocks = parsePdfPages(pages);

const count = t => blocks.filter(b => b.type === t).length;
console.log(`${blocks.length} blocos: ${count('scene')} cenas, ${count('speech')} falas, ${count('direction')} rubricas`);
console.log('Personagens:', charactersOf(blocks).map(c => `${c.name} (${c.lines})`).join(', '));

const show = process.argv.includes('--all') ? blocks : blocks.slice(0, 40);
for (const b of show) {
  if (b.type === 'scene') console.log(`\n== ${b.text}`);
  else if (b.type === 'direction') console.log(`   [${b.text}]`);
  else console.log(`${b.character.padEnd(12)} ${b.text}${b.spoken !== b.text ? `\n${''.padEnd(12)} >> fala: ${b.spoken}` : ''}`);
}

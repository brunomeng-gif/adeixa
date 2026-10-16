// Lê um PDF com o pdf.js e devolve, por página, os pedaços de texto com posição
// e fonte. Funciona no navegador e no Node (o pdfjs é passado como parâmetro).
export async function extractPdfPages(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push({
      items: content.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: it.height || Math.abs(it.transform[3]),
          font: it.fontName,
        })),
    });
  }
  return pages;
}

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { renderPdfPages } from '../src/pdfmd/render.js';
import { createOcrLocalTool } from '../src/plugins/ocr.js';

// Nada se pierde (idea de pdf2md, https://github.com/Ntizar/pdf2md, MIT).

async function twoPagePdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['Uno', 'Dos']) {
    const p = doc.addPage([200, 100]);
    p.drawText(label, { x: 10, y: 50, size: 14, font });
  }
  writeFileSync(path, await doc.save());
}

const PNG = [0x89, 0x50, 0x4e, 0x47];

describe('renderPdfPages (pdfjs real, PDF pequeño)', () => {
  it('guarda solo las páginas pedidas como PNG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-pdfmd-render-'));
    const pdf = join(dir, 'doc.pdf');
    await twoPagePdf(pdf);
    const out = join(dir, 'doc-paginas');
    const saved = await renderPdfPages(pdf, [2, 9], out);
    expect(saved.map((s) => s.page)).toEqual([2]);
    expect([...readFileSync(join(out, 'pagina-2.png')).subarray(0, 4)]).toEqual(PNG);
    expect(existsSync(join(out, 'pagina-1.png'))).toBe(false);
  }, 30_000);
  it('un fichero que no es PDF no rompe: no guarda nada', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-pdfmd-render-'));
    const bad = join(dir, 'roto.pdf');
    writeFileSync(bad, 'esto no es un pdf');
    await expect(renderPdfPages(bad, [1], join(dir, 'x'))).resolves.toEqual([]);
  }, 30_000);
  it('sin páginas pedidas no abre nada', async () => {
    await expect(renderPdfPages('/no/existe.pdf', [], '/tmp/x')).resolves.toEqual([]);
  });
});

const BAD = ['| a | b |', '|---|---|', '| x | 20 |', '| y | 10 |', '| Total | 35 |'].join('\n');
const GOOD = ['| a | b |', '|---|---|', '| x | 20 |', '| y | 10 |', '| Total | 30 |'].join('\n');

describe('ocr_local guarda la página original cuando algo no cuadra', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-pdfmd-ev-'));
  const pdf = join(root, 'factura.pdf');
  const png = join(root, 'ticket.png');
  writeFileSync(pdf, 'x');
  writeFileSync(png, 'x');
  const mk = (out: string) => {
    const calls: { pdf: string; pages: number[]; outDir: string }[] = [];
    const tool = createOcrLocalTool({
      env: { PA_OCR_LOCAL: '1' },
      roots: () => [root],
      run: async () => ({ text: out, pages: 3 }),
      renderPages: async (p, pages, outDir) => {
        calls.push({ pdf: p, pages, outDir });
        return pages.map((n) => ({ page: n, file: join(outDir, `pagina-${n}.png`) }));
      },
    });
    return { tool, calls };
  };
  const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it('tabla sin comprobar y página vacía: se guardan y se enlazan', async () => {
    const { tool, calls } = mk(
      `--- página 1 ---\n${GOOD}\n\n--- página 2 ---\n${BAD}\n\n--- página 3 ---\n`,
    );
    const r = textOf(await tool.execute('1', { path: pdf }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pages).toEqual([2, 3]);
    expect(calls[0]?.outDir).toBe(join(root, 'factura-paginas'));
    expect(r).toContain('He guardado como imagen las páginas 2, 3 junto al PDF');
    expect(r).toContain('![Página 2 del original](factura-paginas/pagina-2.png)');
    expect(r).toContain('![Página 3 del original](factura-paginas/pagina-3.png)');
  });
  it('todo cuadra: no guarda nada', async () => {
    const { tool, calls } = mk(`--- página 1 ---\n${GOOD}\n\n--- página 2 ---\nHola`);
    const r = textOf(await tool.execute('1', { path: pdf }));
    expect(calls).toHaveLength(0);
    expect(r).not.toContain('He guardado');
  });
  it('una foto no es un PDF: no intenta renderizar', async () => {
    const { tool, calls } = mk(BAD);
    await tool.execute('1', { path: png });
    expect(calls).toHaveLength(0);
  });
});

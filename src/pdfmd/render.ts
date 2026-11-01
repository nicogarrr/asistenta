/**
 * Guardar como imagen las páginas de un PDF que no se pudieron leer o comprobar bien,
 * para que la prueba original nunca se pierda. Idea de pdf2md
 * (https://github.com/Ntizar/pdf2md, licencia MIT); aquí con pdfjs-dist y @napi-rs/canvas,
 * que ya vienen con Asistenta (sin dependencias nuevas, sin Python).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { log } from '../log.js';

/** Como mucho se guardan estas páginas por documento. */
export const MAX_EVIDENCE_PAGES = 10;
const SCALE = 1.5;
/** Tope de lado en píxeles (evita páginas gigantes que llenen la memoria). */
const MAX_SIDE = 3000;

export interface SavedPage {
  page: number;
  file: string;
}

interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: unknown): { promise: Promise<void> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface LoadingTask {
  promise: Promise<PdfDoc>;
  destroy(): Promise<void>;
}

function fontsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    return `${join(dirname(req.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;
  } catch {
    return undefined;
  }
}

/**
 * Renderiza las páginas pedidas (1-based) a `outDir/pagina-N.png`. Nunca lanza: lo que no
 * se puede renderizar se salta y queda en el registro. Devuelve lo que sí se guardó.
 */
export async function renderPdfPages(
  pdfPath: string,
  pages: number[],
  outDir: string,
): Promise<SavedPage[]> {
  const wanted = [...new Set(pages)].filter((p) => p >= 1).sort((a, b) => a - b);
  if (wanted.length === 0) return [];
  let task: LoadingTask | undefined;
  const saved: SavedPage[] = [];
  try {
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument(o: unknown): LoadingTask;
    };
    const { createCanvas } = await import('@napi-rs/canvas');
    const data = new Uint8Array(await readFile(pdfPath));
    task = pdfjs.getDocument({ data, isEvalSupported: false, standardFontDataUrl: fontsDir() });
    const doc = await task.promise;
    await mkdir(outDir, { recursive: true });
    for (const n of wanted.slice(0, MAX_EVIDENCE_PAGES)) {
      if (n > doc.numPages) continue;
      try {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(SCALE, MAX_SIDE / Math.max(base.width, base.height, 1));
        const vp = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        const file = join(outDir, `pagina-${n}.png`);
        await writeFile(file, await canvas.encode('png'));
        saved.push({ page: n, file });
      } catch (err) {
        log.warn('pdfmd: no pude guardar la imagen de una página', { page: n, err: String(err) });
      }
    }
  } catch (err) {
    log.warn('pdfmd: no pude abrir el PDF para guardar páginas', { err: String(err) });
  } finally {
    try {
      await task?.destroy();
    } catch {
      // ya cerrado
    }
  }
  return saved;
}

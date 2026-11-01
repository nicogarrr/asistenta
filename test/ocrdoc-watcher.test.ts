import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineDeps } from '../src/ocrdoc/engine.js';
import { OcrFolderWatcher, watchModeFromEnv } from '../src/ocrdoc/watcher.js';
import { openProgress } from '../src/pdfmd/progress.js';
import type { OcrResult } from '../src/screen/ocr.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function digitalPdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 12, font });
  return Buffer.from(await doc.save());
}

const deps = (workDir: string): EngineDeps => ({
  workDir,
  digitalPages: async () => ['Hola mundo, texto digital suficiente de la pagina uno'],
});
const log = { info: () => {}, warn: () => {} };
const ocrRes = (text: string): OcrResult =>
  ({ lines: [], text, language: 'es-ES', width: 10, height: 10 }) as unknown as OcrResult;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pa-watch-'));
  dirs.push(dir);
  const w = new OcrFolderWatcher({ dir, mode: 'md', makeDeps: deps, log, settleMs: 1000 });
  return { dir, w };
}
async function old(path: string): Promise<void> {
  const t = new Date(Date.now() - 60_000);
  await utimes(path, t, t);
}

describe('OcrFolderWatcher', () => {
  it('convierte un PDF estable a Markdown y archiva el original', async () => {
    const { dir, w } = await setup();
    const p = join(dir, 'factura.pdf');
    await writeFile(p, await digitalPdf('Hola'));
    await old(p);
    const first = await w.scanOnce();
    expect(first.processed).toEqual([]); // primera lectura: aún no consta que sea estable
    const second = await w.scanOnce();
    expect(second.processed).toEqual(['factura.pdf']);
    expect(await readdir(join(dir, 'salida'))).toEqual(['factura.md']);
    expect(await readdir(join(dir, 'originales'))).toEqual(['factura.pdf']);
    expect((await readFile(join(dir, 'salida', 'factura.md'), 'utf8')).length).toBeGreaterThan(10);
    expect((await readdir(dir)).includes('factura.pdf')).toBe(false);
  });

  it('no toca archivos recientes ni temporales ni no-PDF ni ocultos', async () => {
    const { dir, w } = await setup();
    const pdf = await digitalPdf('x');
    await writeFile(join(dir, 'fresco.pdf'), pdf);
    for (const n of ['a.pdf.crdownload', 'nota.txt', '.oculto.pdf', '~$doc.pdf']) {
      await writeFile(join(dir, n), pdf);
      await old(join(dir, n));
    }
    await w.scanOnce();
    const r = await w.scanOnce();
    expect(r.processed).toEqual([]);
    expect(r.failed).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(
      ['.oculto.pdf', 'a.pdf.crdownload', 'fresco.pdf', 'nota.txt', '~$doc.pdf'].sort(),
    );
  });

  it('un archivo que cambia entre barridos espera al siguiente', async () => {
    const { dir, w } = await setup();
    const p = join(dir, 'a.pdf');
    await writeFile(p, await digitalPdf('uno'));
    await old(p);
    await w.scanOnce();
    await writeFile(p, await digitalPdf('dos, mas largo que antes'));
    await old(p);
    expect((await w.scanOnce()).processed).toEqual([]);
    expect((await w.scanOnce()).processed).toEqual(['a.pdf']);
  });

  it('un falso PDF va a errores con el motivo y no se pierde', async () => {
    const { dir, w } = await setup();
    const p = join(dir, 'malo.pdf');
    await writeFile(p, 'esto no es un pdf');
    await old(p);
    await w.scanOnce();
    const r = await w.scanOnce();
    expect(r.failed).toEqual(['malo.pdf']);
    expect((await readdir(join(dir, 'errores'))).sort()).toEqual(['malo.pdf', 'malo.pdf.txt']);
    expect(await readFile(join(dir, 'errores', 'malo.pdf.txt'), 'utf8')).toContain('PDF');
  });

  it('no pisa salidas existentes', async () => {
    const { dir, w } = await setup();
    await mkdir(join(dir, 'salida'));
    await writeFile(join(dir, 'salida', 'a.md'), 'previo');
    const p = join(dir, 'a.pdf');
    await writeFile(p, await digitalPdf('hola'));
    await old(p);
    await w.scanOnce();
    await w.scanOnce();
    expect(await readFile(join(dir, 'salida', 'a.md'), 'utf8')).toBe('previo');
    expect((await readdir(join(dir, 'salida'))).sort()).toEqual(['a-2.md', 'a.md']);
  });

  it('modo', () => {
    expect(watchModeFromEnv(undefined)).toBe('md');
    expect(watchModeFromEnv('TODO')).toBe('todo');
    expect(watchModeFromEnv('raro')).toBe('md');
  });

  it('carpeta inexistente no falla', async () => {
    const w = new OcrFolderWatcher({ dir: '/nonexistent-xyz', mode: 'md', makeDeps: deps, log });
    expect(await w.scanOnce()).toEqual({ processed: [], failed: [], skipped: 0 });
  });

  it('dos watchers a la vez: el archivo se procesa una sola vez, sin pérdida', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-race-'));
    dirs.push(dir);
    let calls = 0;
    const slow = (workDir: string): EngineDeps => ({
      workDir,
      digitalPages: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return ['Hola mundo, texto digital suficiente de la pagina uno'];
      },
    });
    const mk = () => new OcrFolderWatcher({ dir, mode: 'md', makeDeps: slow, log, settleMs: 1000 });
    const a = mk();
    const b = mk();
    for (const n of ['a.pdf', 'b.pdf']) {
      await writeFile(join(dir, n), await digitalPdf(n));
      await old(join(dir, n));
    }
    await Promise.all([a.scanOnce(), b.scanOnce()]);
    const [r1, r2] = await Promise.all([a.scanOnce(), b.scanOnce()]);
    expect([...r1.processed, ...r2.processed].sort()).toEqual(['a.pdf', 'b.pdf']);
    expect((await readdir(join(dir, 'originales'))).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect((await readdir(join(dir, 'salida'))).sort()).toEqual(['a.md', 'b.md']);
    expect(calls).toBe(2);
    expect((await readdir(dir)).filter((x) => x.startsWith('.'))).toEqual([]);
  });

  it('si el archivo cambia durante el OCR no se archiva y vuelve a la entrada', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-chg-'));
    dirs.push(dir);
    const p = join(dir, 'a.pdf');
    const claimedMutator = (workDir: string): EngineDeps => ({
      workDir,
      digitalPages: async () => {
        const claim = (await readdir(dir)).find((x) => x.startsWith('.claim-'));
        if (claim)
          await writeFile(join(dir, claim), await digitalPdf('cambiado a mitad, mas largo'));
        return ['Hola mundo, texto digital suficiente de la pagina uno'];
      },
    });
    const w = new OcrFolderWatcher({
      dir,
      mode: 'md',
      makeDeps: claimedMutator,
      log,
      settleMs: 1000,
    });
    await writeFile(p, await digitalPdf('uno'));
    await old(p);
    await w.scanOnce();
    const r = await w.scanOnce();
    expect(r.processed).toEqual([]);
    expect(await readdir(dir)).toEqual(['a.pdf']);
    await expect(readdir(join(dir, 'salida'))).rejects.toThrow();
    await expect(readdir(join(dir, 'originales'))).rejects.toThrow();
  });

  it('un destino creado por otro justo antes de publicar no se pisa', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-clob-'));
    dirs.push(dir);
    const intruder = (workDir: string): EngineDeps => ({
      workDir,
      digitalPages: async () => {
        await mkdir(join(dir, 'salida'), { recursive: true });
        await mkdir(join(dir, 'originales'), { recursive: true });
        await writeFile(join(dir, 'salida', 'a.md'), 'ajeno');
        await writeFile(join(dir, 'originales', 'a.pdf'), 'ajeno');
        return ['Hola mundo, texto digital suficiente de la pagina uno'];
      },
    });
    const w = new OcrFolderWatcher({ dir, mode: 'md', makeDeps: intruder, log, settleMs: 1000 });
    const p = join(dir, 'a.pdf');
    await writeFile(p, await digitalPdf('x'));
    await old(p);
    await w.scanOnce();
    expect((await w.scanOnce()).processed).toEqual(['a.pdf']);
    expect(await readFile(join(dir, 'salida', 'a.md'), 'utf8')).toBe('ajeno');
    expect(await readFile(join(dir, 'originales', 'a.pdf'), 'utf8')).toBe('ajeno');
    expect((await readdir(join(dir, 'salida'))).sort()).toEqual(['a-2.md', 'a.md']);
    expect((await readdir(join(dir, 'originales'))).sort()).toEqual(['a-2.pdf', 'a.pdf']);
  });

  it('si otro proceso ya reclamó el archivo, este watcher no hace nada', async () => {
    const { dir, w } = await setup();
    const p = join(dir, 'a.pdf');
    await writeFile(p, await digitalPdf('x'));
    await old(p);
    await w.scanOnce();
    await rename(p, join(dir, '.claim-ajeno-a.pdf'));
    const r = await w.scanOnce();
    expect(r.processed).toEqual([]);
    expect(await readdir(dir)).toEqual(['.claim-ajeno-a.pdf']);
  });
});

describe('carpeta vigilada: PDF largo que se cortó', () => {
  it('sigue por la página que faltaba y borra el registro al terminar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-watch-prog-'));
    const progressDir = await mkdtemp(join(tmpdir(), 'pa-watch-progdir-'));
    dirs.push(dir, progressDir);
    const doc = await PDFDocument.create();
    doc.addPage([200, 100]);
    doc.addPage([200, 100]);
    const bytes = Buffer.from(await doc.save());
    const done = await openProgress(progressDir, bytes);
    await done.put(0, ocrRes('texto de p1.png'));
    const calls: string[] = [];
    const w = new OcrFolderWatcher({
      dir,
      mode: 'md',
      log,
      settleMs: 1000,
      progressDir,
      makeDeps: (workDir) => ({
        workDir,
        digitalPages: async () => ['', ''],
        renderPage: async (_pdf, i, out) => writeFile(out, `p${i}`),
        ocr: async (png) => {
          const n = png.replace(/.*[\\/]/, '');
          calls.push(n);
          return ocrRes(`texto de ${n}`);
        },
      }),
    });
    const p = join(dir, 'largo.pdf');
    await writeFile(p, bytes);
    await old(p);
    await w.scanOnce();
    expect((await w.scanOnce()).processed).toEqual(['largo.pdf']);
    expect(calls).toEqual(['p2.png']);
    const md = await readFile(join(dir, 'salida', 'largo.md'), 'utf8');
    expect(md).toContain('texto de p1.png');
    expect(md).toContain('texto de p2.png');
    expect(await readdir(progressDir)).toEqual([]);
  }, 20_000);
});

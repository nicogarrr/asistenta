import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { EngineDeps } from '../src/ocrdoc/engine.js';
import { runOcrJob } from '../src/ocrdoc/job.js';
import { docKey, openProgress } from '../src/pdfmd/progress.js';
import type { OcrResult } from '../src/screen/ocr.js';

// Reanudar PDFs largos (idea de pdf2md, https://github.com/Ntizar/pdf2md, MIT).

const res = (text: string): OcrResult =>
  ({ lines: [], text, language: 'es-ES', width: 10, height: 10 }) as unknown as OcrResult;
const tmp = () => mkdtempSync(join(tmpdir(), 'pa-pdfmd-prog-'));

describe('openProgress', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  it('apunta páginas y al reabrir sigue por ahí', async () => {
    const dir = tmp();
    const a = await openProgress(dir, bytes);
    expect(a.resumed).toBe(0);
    await a.put(0, res('uno'));
    await a.put(1, res('dos'));
    const b = await openProgress(dir, bytes);
    expect(b.resumed).toBe(2);
    expect(b.get(1)?.text).toBe('dos');
    expect(b.get(2)).toBeUndefined();
    expect(b.count()).toBe(2);
  });
  it('otro PDF no comparte progreso', async () => {
    const dir = tmp();
    await (await openProgress(dir, bytes)).put(0, res('uno'));
    expect((await openProgress(dir, new Uint8Array([9]))).resumed).toBe(0);
  });
  it('una última línea rota (corte a mitad de escribir) se ignora', async () => {
    const dir = tmp();
    await (await openProgress(dir, bytes)).put(0, res('uno'));
    await appendFile(join(dir, `${docKey(bytes)}.jsonl`), '{"p":1,"r":{"te');
    const b = await openProgress(dir, bytes);
    expect(b.resumed).toBe(1);
    expect(b.get(1)).toBeUndefined();
  });
  it('al terminar se borra', async () => {
    const dir = tmp();
    const a = await openProgress(dir, bytes);
    await a.put(0, res('uno'));
    await a.finish();
    expect(readdirSync(dir)).toEqual([]);
  });
  it('lo que lleva más de 7 días a medias se borra solo', async () => {
    const dir = tmp();
    const old = join(dir, `${'a'.repeat(24)}.jsonl`);
    writeFileSync(old, '{}\n');
    const t = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(old, t, t);
    writeFileSync(join(dir, 'otro.txt'), 'no es mío');
    await openProgress(dir, bytes);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, 'otro.txt'))).toBe(true);
  });
  it('carpeta imposible: funciona sin guardar', async () => {
    const dir = tmp();
    const file = join(dir, 'fichero');
    writeFileSync(file, 'x');
    const a = await openProgress(join(file, 'sub'), bytes);
    await a.put(0, res('uno'));
    expect(a.get(0)?.text).toBe('uno');
  });
});

async function scannedPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 100]);
  return Buffer.from(await doc.save());
}

describe('/ocr de un PDF largo que se corta sigue por donde iba', () => {
  it('primer intento se pasa de tiempo en la página 3; el segundo solo hace la 3', async () => {
    const bytes = await scannedPdf(3);
    const progressDir = tmp();
    const ocrCalls: string[] = [];
    const deps =
      (hangOn: number) =>
      (workDir: string): EngineDeps => ({
        workDir,
        digitalPages: async () => ['', '', ''],
        renderPage: async (_pdf, i, out) => {
          writeFileSync(out, `p${i}`);
        },
        ocr: (png) => {
          ocrCalls.push(png.replace(/.*[\\/]/, ''));
          if (png.endsWith(`p${hangOn}.png`)) return new Promise<OcrResult>(() => {});
          return Promise.resolve(res(`texto de ${png.replace(/.*[\\/]/, '')}`));
        },
      });
    const first = await runOcrJob(
      bytes,
      { name: 'largo.pdf', progressDir },
      'md',
      deps(3),
      undefined,
      300,
    );
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(
      /Lo hecho \(2 páginas\) queda guardado: mándamelo otra vez y sigo por donde iba\./,
    );
    expect(ocrCalls).toEqual(['p1.png', 'p2.png', 'p3.png']);

    ocrCalls.length = 0;
    const second = await runOcrJob(bytes, { name: 'largo.pdf', progressDir }, 'md', deps(99));
    expect(second.ok).toBe(true);
    expect(ocrCalls).toEqual(['p3.png']);
    expect(second.message).toMatch(
      /Ya tenía hechas 2 páginas de la otra vez: he seguido por ahí\./,
    );
    const md = second.files[0]?.bytes.toString('utf8') ?? '';
    expect(md).toContain('texto de p1.png');
    expect(md).toContain('texto de p3.png');
    expect(readdirSync(progressDir)).toEqual([]);
  }, 20_000);
  it('sin carpeta de progreso todo sigue como antes', async () => {
    const bytes = await scannedPdf(1);
    const r = await runOcrJob(bytes, { name: 'a.pdf' }, 'md', (workDir) => ({
      workDir,
      digitalPages: async () => [''],
      renderPage: async (_p, _i, out) => writeFileSync(out, 'x'),
      ocr: async () => res('hola'),
    }));
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(/otra vez/);
  });
});

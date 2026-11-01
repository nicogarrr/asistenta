import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type EngineDeps,
  imageSize,
  MAX_IMAGE_PIXELS,
  MAX_PAGES,
  ocrPdf,
  ocrPhoto,
} from '../src/ocrdoc/engine.js';
import { detectKind, outputName, parseOcrMode, runOcrJob } from '../src/ocrdoc/job.js';
import { buildRenderScript, digitalPagesPdfjs } from '../src/ocrdoc/windows.js';
import type { OcrResult } from '../src/screen/ocr.js';

/** PNG blanco real de w x h (RGB), construido a mano para no depender de nada más. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 255)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function digitalPdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 700, size: 12, font });
  return doc.save();
}

async function scannedPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png(40, 56));
  for (let i = 0; i < pages; i++) {
    doc.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  }
  return doc.save();
}

function fakeOcr(text: string): OcrResult {
  return {
    lines: [{ text, x: 100, y: 200, width: 1200, height: 60, words: [] }],
    text,
    language: 'es-ES',
    width: 2480,
    height: 3508,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function mkDeps(workDir: string, over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    workDir,
    digitalPages: (b) => digitalPagesPdfjs(b),
    renderPage: async (_pdf, _i, out) => writeFile(out, 'png'),
    ocr: async () => fakeOcr('Factura número 123 total 45,60 euros'),
    ...over,
  };
}
async function deps(over: Partial<EngineDeps> = {}): Promise<EngineDeps> {
  const d = await mkdtemp(join(tmpdir(), 'ocrdoc-test-'));
  dirs.push(d);
  return mkDeps(d, over);
}
const sync =
  (over: Partial<EngineDeps> = {}) =>
  (workDir: string): EngineDeps =>
    mkDeps(workDir, over);

describe('ocrPdf', () => {
  it('un PDF escaneado sale con texto buscable en la página original', async () => {
    const input = await scannedPdf(1);
    expect((await digitalPagesPdfjs(input))[0]?.trim()).toBe('');
    const r = await ocrPdf(input, 'scan.pdf', await deps());
    expect(r.ocrPages).toBe(1);
    const out = r.pdf as Uint8Array;
    expect((await digitalPagesPdfjs(out))[0]).toContain('Factura número 123');
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
    expect(r.markdown).toContain('reconocido por OCR');
    expect(r.markdown).toContain('puede tener errores');
  });

  it('un PDF digital no se toca y no pide OCR', async () => {
    const input = await digitalPdf('Contrato de alquiler entre las partes firmantes');
    let renders = 0;
    const r = await ocrPdf(
      input,
      'doc.pdf',
      await deps({ renderPage: async () => void renders++ }),
    );
    expect(renders).toBe(0);
    expect(r.alreadySearchable).toBe(true);
    expect(r.pdf).toBe(input);
    expect(r.markdown).toContain('Contrato de alquiler');
  });

  it('conserva texto digital corto sin OCR disponible', async () => {
    const input = await digitalPdf('Total 45,60 EUR');
    const r = await ocrPdf(
      input,
      'corto.pdf',
      await deps({ renderPage: undefined, ocr: undefined }),
    );
    expect(r.pdf).toBe(input);
    expect(r.markdown).toContain('Total 45,60 EUR');
    expect(r.digitalPages).toBe(1);
    expect(r.pages[0]?.reason).toContain('parcial');
    expect(r.alreadySearchable).toBe(false);
  });

  it('conserva texto propio corto si el OCR falla o no añade texto', async () => {
    for (const ocr of [
      async () => {
        throw new Error('motor roto');
      },
      async () => fakeOcr(''),
    ]) {
      const input = await digitalPdf('Total 45,60 EUR');
      const r = await ocrPdf(input, 'corto.pdf', await deps({ ocr }));
      expect(r.pdf).toBe(input);
      expect(r.markdown).toContain('Total 45,60 EUR');
      expect(r.digitalPages).toBe(1);
      expect(r.alreadySearchable).toBe(false);
    }
  });

  it('runOcrJob md no dice ilegible si contiene texto digital corto', async () => {
    const input = Buffer.from(await digitalPdf('Total 45,60 EUR'));
    const r = await runOcrJob(
      input,
      { name: 'corto.pdf' },
      'md',
      sync({ renderPage: undefined, ocr: undefined }),
    );
    expect(r.ok).toBe(true);
    expect(r.files[0]?.bytes.toString()).toContain('Total 45,60 EUR');
    expect(r.message).toContain('parcial');
  });

  it('mezcla: la página digital se queda y solo la escaneada pasa por OCR', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('Texto propio de la primera página del documento', {
      x: 40,
      y: 700,
      size: 12,
      font,
    });
    doc
      .addPage([595, 842])
      .drawImage(await doc.embedPng(png(10, 14)), { x: 0, y: 0, width: 595, height: 842 });
    const r = await ocrPdf(await doc.save(), 'mix.pdf', await deps());
    expect(r.pages.map((p) => p.source)).toEqual(['digital', 'ocr']);
    const pages = await digitalPagesPdfjs(r.pdf as Uint8Array);
    expect(pages[0]).toContain('Texto propio');
    expect(pages[1]).toContain('Factura');
    expect(r.markdown.indexOf('## Página 1')).toBeLessThan(r.markdown.indexOf('## Página 2'));
  });

  it('si falla el OCR de una página, la deja igual y lo dice', async () => {
    const r = await ocrPdf(
      await scannedPdf(2),
      's.pdf',
      await deps({
        ocr: async (p) => {
          if (p.endsWith('p2.png')) throw new Error('motor roto');
          return fakeOcr('Primera página legible del escaneo');
        },
      }),
    );
    expect(r.pages.map((p) => p.source)).toEqual(['ocr', 'sin_leer']);
    expect(r.pages[1]?.reason).toContain('motor roto');
    expect(r.markdown).toContain('no se pudo leer: motor roto');
  });

  it('sin OCR disponible (no Windows) devuelve null y explica por qué', async () => {
    const r = await ocrPdf(
      await scannedPdf(1),
      's.pdf',
      await deps({ renderPage: undefined, ocr: undefined, noOcrReason: 'solo Windows' }),
    );
    expect(r.pdf).toBeNull();
    expect(r.pages[0]?.reason).toBe('solo Windows');
  });

  it('página sin nada reconocido: lo dice y no inventa texto', async () => {
    const r = await ocrPdf(
      await scannedPdf(1),
      'b.pdf',
      await deps({ ocr: async () => ({ ...fakeOcr(''), lines: [], text: '' }) }),
    );
    expect(r.pages[0]?.source).toBe('vacia');
    expect(r.markdown).toContain('sin texto reconocido');
  });

  it('rechaza un PDF corrupto con un mensaje claro', async () => {
    await expect(
      ocrPdf(new TextEncoder().encode('%PDF-1.4 basura'), 'x.pdf', await deps()),
    ).rejects.toThrow(/No he podido abrir el PDF/);
  });

  it('rechaza demasiadas páginas antes de procesar nada', async () => {
    let renders = 0;
    await expect(
      ocrPdf(
        await scannedPdf(MAX_PAGES + 1),
        'big.pdf',
        await deps({ renderPage: async () => void renders++ }),
      ),
    ).rejects.toThrow(/máximo por envío/);
    expect(renders).toBe(0);
  });

  it('una página girada no se procesa (no coloca texto torcido)', async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([595, 842]);
    p.drawImage(await doc.embedPng(png(10, 14)), { x: 0, y: 0, width: 595, height: 842 });
    p.setRotation({ type: 'degrees' as never, angle: 90 });
    const r = await ocrPdf(await doc.save(), 'r.pdf', await deps());
    expect(r.pages[0]?.source).toBe('sin_leer');
    expect(r.pages[0]?.reason).toContain('girada');
  });

  it('caracteres fuera de WinAnsi no rompen la capa de texto', async () => {
    const r = await ocrPdf(
      await scannedPdf(1),
      'e.pdf',
      await deps({ ocr: async () => fakeOcr('Total 12 € ñandú 😀 Привет') }),
    );
    const text = (await digitalPagesPdfjs(r.pdf as Uint8Array))[0] ?? '';
    expect(text).toContain('ñandú');
    expect(text).toContain('Total 12');
    expect(text).not.toContain('Привет');
    // 6 cirílicas + 1 emoji (un solo punto de código) = 7 caracteres fuera de WinAnsi
    expect(r.droppedChars).toBe(7);
    expect(r.pages[0]?.droppedChars).toBe(7);
    // el Markdown conserva el texto completo
    expect(r.markdown).toContain('Привет');
    expect(r.markdown).toContain('😀');
  });

  it('acentos y ñ (WinAnsi) no cuentan como perdidos', async () => {
    const r = await ocrPdf(
      await scannedPdf(1),
      'a.pdf',
      await deps({ ocr: async () => fakeOcr('Código número ñandú sección España ¿qué? € Ü') }),
    );
    expect(r.droppedChars).toBe(0);
    const text = (await digitalPagesPdfjs(r.pdf as Uint8Array))[0] ?? '';
    for (const w of ['Código', 'número', 'ñandú', 'sección', 'España', '¿qué?']) {
      expect(text).toContain(w);
    }
  });

  it('shouldStop cancela antes de la siguiente página', async () => {
    let renders = 0;
    await expect(
      ocrPdf(
        await scannedPdf(3),
        's.pdf',
        await deps({ renderPage: async () => void renders++, shouldStop: () => renders >= 1 }),
      ),
    ).rejects.toThrow(/Cancelado/);
    expect(renders).toBe(1);
  });

  it('el título del Markdown no deja que el nombre inyecte formato', async () => {
    const r = await ocrPdf(
      await digitalPdf('Texto digital suficientemente largo para contar'),
      '# x\n[a](http://e.vil)|*.pdf',
      await deps(),
    );
    const first = r.markdown.split('\n')[0] ?? '';
    expect(first.startsWith('# ')).toBe(true);
    expect(first).not.toMatch(/[[\]|*]/);
  });
});

describe('ocrPhoto', () => {
  it('una foto PNG sale como PDF de una página con texto buscable', async () => {
    const r = await ocrPhoto(png(200, 300), 'image/png', 'foto.png', await deps());
    expect(r.ocrPages).toBe(1);
    const doc = await PDFDocument.load(r.pdf as Uint8Array);
    expect(doc.getPageCount()).toBe(1);
    expect((await digitalPagesPdfjs(r.pdf as Uint8Array))[0]).toContain('Factura');
  });

  it('sin OCR disponible falla claro', async () => {
    await expect(
      ocrPhoto(
        png(10, 10),
        'image/png',
        'f.png',
        await deps({ ocr: undefined, noOcrReason: 'solo Windows' }),
      ),
    ).rejects.toThrow(/solo Windows/);
  });

  it('una imagen corrupta falla claro', async () => {
    await expect(ocrPhoto(Buffer.from('nada'), 'image/png', 'f.png', await deps())).rejects.toThrow(
      /No he podido abrir la imagen/,
    );
  });

  it('una imagen-bomba se rechaza leyendo solo la cabecera', async () => {
    const bomb = png(10, 10);
    bomb.writeUInt32BE(30000, 16);
    bomb.writeUInt32BE(30000, 20);
    expect(imageSize(bomb)).toEqual({ width: 30000, height: 30000 });
    expect(30000 * 30000).toBeGreaterThan(MAX_IMAGE_PIXELS);
    await expect(ocrPhoto(bomb, 'image/png', 'b.png', await deps())).rejects.toThrow(
      /demasiado grande/,
    );
  });

  it('imageSize lee JPEG (SOF0)', () => {
    const jpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x90,
      0x02, 0x58, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(imageSize(jpg)).toEqual({ width: 600, height: 400 });
  });
});

describe('runOcrJob', () => {
  it('devuelve PDF por defecto, Markdown con md y los dos con todo; avisa del OCR', async () => {
    const input = Buffer.from(await scannedPdf(1));
    const a = await runOcrJob(input, { name: 'Mi escaneo.pdf' }, 'pdf', sync());
    expect(a.ok).toBe(true);
    expect(a.files.map((f) => f.filename)).toEqual(['Mi escaneo_OCR.pdf']);
    expect(a.message).toContain('puede equivocarse');
    const b = await runOcrJob(input, { name: 'Mi escaneo.pdf' }, 'md', sync());
    expect(b.files.map((f) => f.filename)).toEqual(['Mi escaneo.md']);
    const c = await runOcrJob(input, { name: 'Mi escaneo.pdf' }, 'todo', sync());
    expect(c.files.map((f) => f.filename)).toEqual(['Mi escaneo_OCR.pdf', 'Mi escaneo.md']);
  });

  it('avisa de que la búsqueda en el PDF queda incompleta, según el modo', async () => {
    const input = Buffer.from(await scannedPdf(1));
    const ocr = async () => fakeOcr('Pago 5 € Привет 😀');
    const pdf = await runOcrJob(input, { name: 's.pdf' }, 'pdf', sync({ ocr }));
    expect(pdf.ok).toBe(true);
    expect(pdf.message).toContain('7 caracteres');
    expect(pdf.message).toContain('incompleto');
    // Nico (1 nov): sin mandar a «/ocr md»; el texto completo va ya en el archivo de texto.
    expect(pdf.message).toContain('te lo mando también, en el archivo de texto');
    expect(pdf.message).not.toMatch(/\/ocr/);
    expect(pdf.files.map((f) => f.filename)).toEqual(['s_OCR.pdf', 's.md']);
    expect(pdf.files[1]?.bytes.toString()).toContain('Привет');
    const both = await runOcrJob(input, { name: 's.pdf' }, 'todo', sync({ ocr }));
    expect(both.message).toContain('está en el Markdown');
    expect(both.files.map((f) => f.filename)).toEqual(['s_OCR.pdf', 's.md']);
    const clean = await runOcrJob(input, { name: 's.pdf' }, 'pdf', sync());
    expect(clean.message).not.toContain('Aviso');
  });

  it('PDF ya digital: lo dice y no promete OCR', async () => {
    const input = Buffer.from(await digitalPdf('Texto digital suficientemente largo para contar'));
    const r = await runOcrJob(input, { name: 'd.pdf' }, 'pdf', sync());
    expect(r.ok).toBe(true);
    expect(r.message).toContain('ya tenía texto');
    expect(r.message).not.toContain('puede equivocarse');
  });

  it('el tipo sale del contenido: un .pdf que es otra cosa se rechaza', async () => {
    const r = await runOcrJob(Buffer.from('MZ....'), { name: 'a.pdf' }, 'pdf', sync());
    expect(r.message).toContain('Solo leo PDF');
    expect((await runOcrJob(Buffer.alloc(0), {}, 'pdf', sync())).ok).toBe(false);
    expect((await runOcrJob(Buffer.alloc(21 * 1024 * 1024), {}, 'pdf', sync())).message).toContain(
      '20 MB',
    );
  });

  it('un PDF corrupto devuelve error amable y no deja carpetas temporales', async () => {
    const count = async () =>
      (await readdir(tmpdir())).filter((n) => n.startsWith('pa-ocr-')).length;
    const before = await count();
    const r = await runOcrJob(Buffer.from('%PDF-1.4 roto'), { name: 'x.pdf' }, 'pdf', sync());
    expect(r.ok).toBe(false);
    expect(r.files).toEqual([]);
    expect(await count()).toBe(before);
  });

  it('si nada se puede leer, falla sin devolver ficheros', async () => {
    const r = await runOcrJob(
      Buffer.from(await scannedPdf(1)),
      { name: 's.pdf' },
      'pdf',
      sync({ renderPage: undefined, ocr: undefined, noOcrReason: 'solo Windows' }),
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('solo Windows');
    expect(r.files).toEqual([]);
  });

  it('el tiempo máximo corta el trabajo, avisa y borra la carpeta', async () => {
    let workDir = '';
    const r = await runOcrJob(
      Buffer.from(await scannedPdf(3)),
      { name: 's.pdf' },
      'pdf',
      (d) => {
        workDir = d;
        return mkDeps(d, {
          ocr: async () => {
            await new Promise((res) => setTimeout(res, 150));
            return fakeOcr('texto de una página escaneada');
          },
        });
      },
      undefined,
      100,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('tiempo máximo');
    await new Promise((res) => setTimeout(res, 400));
    const left = await readdir(workDir).catch(() => 'borrada');
    expect(left).toBe('borrada');
  });
});

describe('helpers', () => {
  it('parseOcrMode', () => {
    expect(parseOcrMode('')).toBe('pdf');
    expect(parseOcrMode('MD')).toBe('md');
    expect(parseOcrMode('todo')).toBe('todo');
    expect(parseOcrMode('xyz')).toBeNull();
  });
  it('detectKind por contenido, no por la extensión', async () => {
    expect(detectKind(await digitalPdf('x'))).toBe('pdf');
    expect(detectKind(png(2, 2))).toBe('png');
    expect(detectKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectKind(Buffer.from('MZ....'))).toBeNull();
  });
  it('outputName limpia el nombre y no usa el original', () => {
    expect(outputName('../../etc/pass wd?.pdf', '_OCR', 'pdf')).not.toContain('/');
    expect(outputName('..pdf', '_OCR', 'pdf').startsWith('.')).toBe(false);
    expect(outputName(undefined, '_OCR', 'pdf')).toBe('documento_OCR.pdf');
  });
  it('el script de render lleva ruta y página en base64 y número saneado', () => {
    const s = buildRenderScript('QUJD', 3, 'REVG', 2480);
    expect(s).toContain("FromBase64String('QUJD')");
    expect(s).toContain('GetPage(3)');
    expect(s).toContain('DestinationWidth = 2480');
    expect(buildRenderScript('a', -5, 'b', 10)).toContain('GetPage(0)');
  });
});

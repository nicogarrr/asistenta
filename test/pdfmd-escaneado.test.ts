import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { OcrJobResult } from '../src/ocrdoc/job.js';
import { pdfSummaryIntent } from '../src/pdfmd/chat-intent.js';
import { ocrScannedForModel } from '../src/pdfmd/scanned.js';

const pdf = (text: string) => ({
  text,
  documentFileId: 'f1',
  documentMimeType: 'application/pdf',
  documentName: 'escaneo.pdf',
});

describe('«resume este PDF» con un PDF adjunto', () => {
  it.each(['resume este PDF', 'Resúmemelo', '¿de qué va?', '¿qué dice este pdf?', 'léemelo'])(
    '«%s» pide leerlo',
    (text) => {
      expect(pdfSummaryIntent(pdf(text))).toBe(true);
    },
  );
  it.each(['', 'guárdalo', '/ocr', 'pásame este PDF a texto'])('«%s» no', (text) => {
    expect(pdfSummaryIntent(pdf(text))).toBe(false);
  });
  it('sin PDF no', () => {
    expect(pdfSummaryIntent({ text: 'resume esto' })).toBe(false);
  });
});

const job = (md: string, ok = true): OcrJobResult => ({
  ok,
  message: ok ? 'Páginas: 2 reconocidas con OCR.' : 'Se ha pasado el tiempo máximo.',
  files: ok ? [{ bytes: Buffer.from(md, 'utf8'), filename: 'escaneo.md' }] : [],
});
const bytes = Buffer.from('%PDF-1.7 fake');

describe('PDF escaneado: primero el OCR, luego el modelo', () => {
  it('lee el texto, lo guarda y le dice al modelo que lo use', async () => {
    const index = vi.fn((md: string) => ({ chars: md.length }));
    const run = vi.fn(async () => job('Contrato de alquiler. Renta 800 euros al mes.'));
    const note = await ocrScannedForModel(bytes, 'escaneo.pdf', {
      available: async () => true,
      run,
      index,
    });
    expect(run).toHaveBeenCalledWith(bytes, { name: 'escaneo.pdf' }, 'md');
    expect(index).toHaveBeenCalledWith('Contrato de alquiler. Renta 800 euros al mes.');
    expect(note).toMatch(/PDF escaneado: lo he leído con el OCR local e indexado/);
    expect(note).toMatch(/herramienta documents/);
    expect(note).not.toMatch(/tabla/);
  });

  it('si una tabla no cuadra, la nota pide avisar', async () => {
    const md = [
      '| Concepto | Euros |',
      '|---|---|',
      '| Luz | 40 |',
      '| Agua | 60 |',
      '| Total | 108 |',
    ].join('\n');
    const note = await ocrScannedForModel(bytes, 'escaneo.pdf', {
      available: async () => true,
      run: async () => job(md),
      index: (t) => ({ chars: t.length }),
    });
    expect(note).toMatch(/Ojo: alguna tabla no cuadra/);
    expect(note).toMatch(/revise con el original/);
  });

  it('sin OCR en el PC, OCR fallido o sin texto: se queda la nota de siempre', async () => {
    const index = vi.fn(() => ({ chars: 1 }));
    const run = vi.fn(async () => job('x'));
    expect(
      await ocrScannedForModel(bytes, 'a.pdf', { available: async () => false, run, index }),
    ).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(
      await ocrScannedForModel(bytes, 'a.pdf', {
        available: async () => true,
        run: async () => job('', false),
        index,
      }),
    ).toBeNull();
    expect(
      await ocrScannedForModel(bytes, 'a.pdf', {
        available: async () => true,
        run: async () => {
          throw new Error('boom');
        },
        index,
      }),
    ).toBeNull();
    expect(
      await ocrScannedForModel(bytes, 'a.pdf', {
        available: async () => true,
        run: async () => job('   '),
        index,
      }),
    ).toBeNull();
    expect(index).not.toHaveBeenCalled();
  });
});

describe('enganche en el turno', () => {
  const cli = readFileSync('src/cli.ts', 'utf8');
  it('solo si el PDF no tenía texto y el dueño pide leerlo', () => {
    expect(cli).toMatch(
      /!indexed &&\s+!ocrBusy &&\s+isOwnerDm\(inbound, vigilanteOwnerId\) &&\s+pdfSummaryIntent\(inbound\)/,
    );
    expect(cli).toMatch(/await ocrScannedForModel\(bytes, label, \{/);
    expect(cli).toMatch(/: \(scanned \?\?/);
  });
});

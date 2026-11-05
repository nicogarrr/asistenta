/**
 * «Pasa el contrato que te mandé a mis apuntes de derecho»: un documento que ya está en «mis
 * documentos» se copia a un tema (con el texto guardado al llegar). Antes no había forma: había
 * que volver a mandarlo.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseExpertos } from '../src/expertos/base.js';
import { expertoDesdeDocumentos } from '../src/expertos/turno.js';
import { createExpertosTool } from '../src/tools/expertos.js';

let dir: string;
let base: BaseExpertos;
const DOCS = [
  { docId: 'aaaaaaaaaaaaaaaa', title: 'Contrato alquiler.pdf' },
  { docId: 'bbbbbbbbbbbbbbbb', title: 'Contrato luz.pdf' },
  { docId: 'cccccccccccccccc', title: 'foto' },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'expertos1-docs-'));
  mkdirSync(join(dir, 'mirror'));
  writeFileSync(
    join(dir, 'mirror', 'aaaaaaaaaaaaaaaa.txt'),
    'Cláusula 3. La fianza es de dos mensualidades y se devuelve al terminar el contrato.',
  );
  writeFileSync(join(dir, 'mirror', 'bbbbbbbbbbbbbbbb.txt'), 'Potencia contratada 4,6 kW.');
  base = new BaseExpertos({ root: join(dir, 'ex'), dbPath: join(dir, 'i.sqlite'), rescanMs: 0 });
});
afterEach(() => {
  base.close();
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('de «mis documentos» a un tema', () => {
  it('encuentra el documento por id o por un trozo del título sin tildes', () => {
    expect(expertoDesdeDocumentos(DOCS, '[aaaaaaaaaaaaaaaa]', join(dir, 'mirror'))).toMatchObject({
      title: 'Contrato alquiler.pdf',
    });
    expect(expertoDesdeDocumentos(DOCS, 'alquiler', join(dir, 'mirror'))).toMatchObject({
      title: 'Contrato alquiler.pdf',
    });
    expect(expertoDesdeDocumentos(DOCS, 'contrato', join(dir, 'mirror'))).toBe('varios');
    expect(expertoDesdeDocumentos(DOCS, 'foto', join(dir, 'mirror'))).toBeNull();
    expect(expertoDesdeDocumentos(DOCS, 'hipoteca', join(dir, 'mirror'))).toBeNull();
  });

  it('el tool lo copia al tema, se puede buscar y avisa de que va sin páginas', async () => {
    const tool = createExpertosTool(base, {
      fromDocs: (ref) => expertoDesdeDocumentos(DOCS, ref, join(dir, 'mirror')),
    });
    const out = textOf(
      await tool.execute('1', { action: 'desde_documentos', tema: 'derecho', archivo: 'alquiler' }),
    );
    expect(out).toContain('Copiado «Contrato alquiler.pdf» a derecho como «Contrato alquiler.txt»');
    expect(out).toContain('sin números de página');
    expect((await base.buscar('¿de cuánto es la fianza?', { tema: 'derecho' }))[0]?.archivo).toBe(
      'Contrato alquiler.txt',
    );
    const dup = textOf(
      await tool.execute('2', { action: 'desde_documentos', tema: 'derecho', archivo: 'contrato' }),
    );
    expect(dup).toContain('Hay varios documentos');
  });
});

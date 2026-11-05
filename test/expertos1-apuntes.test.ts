/**
 * Apuntes por tema («modo experto»): Nico mete sus apuntes de derecho en una carpeta por
 * tema y Asistenta busca en ellos antes de contestar, citando archivo y página/sección.
 * Antes no existía: solo la memoria documental del chat, que exige TODAS las palabras y no
 * guarda la página. Sin red, sin modelo; el PDF se simula por páginas.
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BaseExpertos,
  encabezado,
  nombreTema,
  palabrasClave,
  trocear,
} from '../src/expertos/base.js';
import { Gate } from '../src/permissions.js';
import { createExpertosTool } from '../src/tools/expertos.js';

let dir: string;
let base: BaseExpertos;

const CIVIL = [
  '# Código Civil — mis apuntes',
  '',
  'Artículo 1544. Arrendamiento',
  'En el arrendamiento de obras o servicios, una de las partes se obliga a ejecutar una obra o a prestar a la otra un servicio por precio cierto.',
  '',
  'Artículo 1555',
  'El arrendatario está obligado a pagar el precio del arrendamiento en los términos convenidos y a usar la cosa arrendada como un diligente padre de familia.',
].join('\n');

const PDF_PAGES = [
  { pag: 1, texto: 'Tema 4\nLa prescripción extintiva en derecho civil.' },
  {
    pag: 2,
    texto:
      'Las acciones personales que no tengan plazo especial prescriben a los cinco años desde que pueda exigirse el cumplimiento de la obligación.',
  },
];

function nuevaBase(): BaseExpertos {
  return new BaseExpertos({
    root: join(dir, 'expertos'),
    dbPath: join(dir, 'idx.sqlite'),
    rescanMs: 0,
    pdfPages: async () => PDF_PAGES,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'expertos1-'));
  mkdirSync(join(dir, 'expertos', 'derecho'), { recursive: true });
  writeFileSync(join(dir, 'expertos', 'derecho', 'civil.md'), CIVIL);
  writeFileSync(join(dir, 'expertos', 'derecho', 'tema4.pdf'), Buffer.from('%PDF-1.4 falso'));
  writeFileSync(join(dir, 'expertos', 'derecho', 'foto.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  base = nuevaBase();
});
afterEach(() => {
  base.close();
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('base de apuntes por tema', () => {
  it('lista los temas con sus archivos; la foto sin OCR queda «sin leer» con el motivo', async () => {
    await base.reindexar(true);
    const [t] = base.temas();
    expect(t?.nombre).toBe('derecho');
    expect(t?.archivos).toBe(3);
    expect(t?.sinLeer).toEqual([
      { archivo: 'foto.jpg', motivo: 'foto: el OCR local no está disponible' },
    ]);
  });

  it('una pregunta normal encuentra el artículo y lo cita con su sección', async () => {
    const hits = await base.buscar('¿Qué obligaciones tiene el arrendatario?');
    expect(hits[0]?.archivo).toBe('civil.md');
    expect(hits[0]?.donde).toBe('Artículo 1555');
    expect(hits[0]?.texto).toContain('pagar el precio');
  });

  it('el PDF se cita con su página y el tema que va arrastrando', async () => {
    const hits = await base.buscar('¿en cuántos años prescriben las acciones personales?', {
      tema: 'derecho',
    });
    expect(hits[0]?.archivo).toBe('tema4.pdf');
    expect(hits[0]?.donde).toBe('pág. 2, Tema 4');
  });

  it('sin tildes y con plurales también encuentra («prescripcion», «arrendamientos»)', async () => {
    expect((await base.buscar('prescripcion'))[0]?.archivo).toBe('tema4.pdf');
    expect((await base.buscar('arrendamientos de servicios'))[0]?.archivo).toBe('civil.md');
  });

  it('reindexa solo lo cambiado y saca lo que se borró de la carpeta', async () => {
    await base.reindexar(true);
    const f = join(dir, 'expertos', 'derecho', 'civil.md');
    writeFileSync(
      f,
      `${CIVIL}\n\nArtículo 1561\nEl arrendatario debe devolver la finca al concluir el arriendo.`,
    );
    utimesSync(f, new Date(), new Date(Date.now() + 5_000));
    const r = await base.reindexar(true);
    expect(r).toMatchObject({ nuevos: 0, cambiados: 1, borrados: 0 });
    expect((await base.buscar('devolver la finca'))[0]?.donde).toBe('Artículo 1561');
    unlinkSync(join(dir, 'expertos', 'derecho', 'tema4.pdf'));
    expect((await base.reindexar(true)).borrados).toBe(1);
    expect(await base.buscar('prescripción extintiva')).toEqual([]);
  });

  it('el índice sobrevive a un reinicio sin releer nada', async () => {
    await base.reindexar(true);
    base.close();
    base = nuevaBase();
    expect(await base.reindexar(true)).toMatchObject({ nuevos: 0, cambiados: 0, borrados: 0 });
  });

  it('añadir un archivo crea el tema si no existe y lo indexa al momento', async () => {
    const r = await base.anadir(
      'Oposiciones',
      'temario.txt',
      Buffer.from('Tema 1\nLa Constitución española de 1978 consta de 169 artículos.'),
    );
    expect(r).toMatchObject({ tema: 'oposiciones', archivo: 'temario.txt', motivo: '' });
    expect(
      (await base.buscar('artículos tiene la constitución', { tema: 'oposiciones' }))[0]?.donde,
    ).toBe('Tema 1');
  });

  it('nombres de tema y archivo nunca salen de la carpeta', () => {
    expect(nombreTema('Derecho Civil')).toBe('derecho civil');
    expect(nombreTema('../../Windows')).toBe('windows');
    expect(nombreTema('..')).toBeNull();
  });

  it('encabezados y palabras clave', () => {
    expect(encabezado('Artículo 12 bis. Del arrendamiento')).toBe(
      'Artículo 12 bis. Del arrendamiento',
    );
    expect(encabezado('## Prescripción')).toBe('Prescripción');
    expect(encabezado('El artículo 12 dice que…')).toBeNull();
    expect(palabrasClave('¿Qué dicen mis apuntes sobre la prescripción?')).toEqual([
      'prescripcion',
    ]);
    expect(trocear([{ texto: 'Tema 2\nhola' }])[0]?.donde).toBe('Tema 2');
  });
});

describe('tool expertos', () => {
  it('buscar devuelve pasajes con la fuente y la regla de citar; las instrucciones del tema van detrás', async () => {
    const tool = createExpertosTool(base);
    await tool.execute('1', {
      action: 'instrucciones',
      tema: 'Derecho',
      texto: 'cita artículos, derecho español',
    });
    const out = textOf(
      await tool.execute('2', {
        action: 'buscar',
        tema: 'derecho',
        query: 'obligaciones del arrendatario',
      }),
    );
    expect(out).toContain('[1] civil.md, Artículo 1555: «');
    expect(out).toContain('Instrucciones del tema: cita artículos, derecho español');
    expect(out).toContain('conocimiento general');
  });

  it('si los apuntes no lo cubren, lo dice para que el modelo no se lo invente', async () => {
    const tool = createExpertosTool(base);
    const out = textOf(
      await tool.execute('1', { action: 'buscar', tema: 'derecho', query: 'hipoteca inversa' }),
    );
    expect(out).toMatch(/^No encontré nada sobre eso en los apuntes de derecho/);
  });

  it('fuera del chat privado del dueño no enseña nada', async () => {
    const tool = createExpertosTool(base, { allowed: () => false });
    const out = textOf(await tool.execute('1', { action: 'temas' }));
    expect(out).toContain('solo se usan en el chat privado del dueño');
  });

  it('quitar un archivo pide el sí primero y solo luego borra', async () => {
    const tool = createExpertosTool(base);
    await tool.execute('0', { action: 'temas' });
    const ask = textOf(
      await tool.execute('1', {
        action: 'quitar',
        tema: 'derecho',
        archivo: 'civil.md',
        confirm: true,
      }),
    );
    expect(ask).toContain('Vas a quitar «civil.md»');
    const done = textOf(
      await tool.execute('2', {
        action: 'quitar',
        tema: 'derecho',
        archivo: 'civil.md',
        confirm: true,
      }),
    );
    expect(done).toBe('Quitado «civil.md» de derecho.');
    expect(base.archivos('derecho').map((f) => f.archivo)).not.toContain('civil.md');
  });

  it('la Gate: buscar es lectura, guardar escribe en local', () => {
    const gate = new Gate();
    expect(
      gate.classifyEffect({ tool: 'expertos', args: { action: 'buscar' }, actor: 'test' }),
    ).toBe('lee');
    expect(
      gate.classifyEffect({ tool: 'expertos', args: { action: 'guardar_texto' }, actor: 'test' }),
    ).toBe('escribe-local');
  });
});

describe('PDF real (pdf-lib → pdfjs)', () => {
  it('cada página se cita con su número', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([400, 400]);
    p1.drawText('Tema 7', { x: 40, y: 340, size: 14, font });
    p1.drawText('La compraventa es un contrato consensual.', { x: 40, y: 300, size: 11, font });
    const p2 = doc.addPage([400, 400]);
    p2.drawText('El saneamiento por vicios ocultos dura seis meses.', {
      x: 40,
      y: 340,
      size: 11,
      font,
    });
    const real = new BaseExpertos({
      root: join(dir, 'real'),
      dbPath: join(dir, 'real.sqlite'),
      rescanMs: 0,
    });
    try {
      const r = await real.anadir('civil', 'compraventa.pdf', Buffer.from(await doc.save()));
      expect(r?.motivo).toBe('');
      const [hit] = await real.buscar('vicios ocultos saneamiento');
      expect(hit?.archivo).toBe('compraventa.pdf');
      expect(hit?.donde).toBe('pág. 2, Tema 7');
    } finally {
      real.close();
    }
  });
});

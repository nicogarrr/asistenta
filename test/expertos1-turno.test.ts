/**
 * Apuntes por tema, en el turno: «según mis apuntes de derecho…», «/experto derecho ¿…?» o
 * una pregunta que sale en sus apuntes llegan al modelo con los pasajes y la regla de citar;
 * si no los cubren, la nota lo dice. «añade esto a derecho» como pie de un archivo lo mete
 * en el tema. Antes nada de esto existía: el modelo contestaba de memoria.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseExpertos } from '../src/expertos/base.js';
import {
  notaApuntes,
  peticionApuntes,
  temaParaAnadir,
  textoComandoExperto,
} from '../src/expertos/turno.js';

let dir: string;
let base: BaseExpertos;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'expertos1-turno-'));
  mkdirSync(join(dir, 'ex', 'derecho'), { recursive: true });
  writeFileSync(
    join(dir, 'ex', 'derecho', 'civil.md'),
    'Artículo 1555\nEl arrendatario está obligado a pagar el precio del arrendamiento en los términos convenidos.\n\nArtículo 1930\nLa usucapión es la adquisición del dominio por la posesión continuada durante el tiempo que marca la ley.',
  );
  base = new BaseExpertos({ root: join(dir, 'ex'), dbPath: join(dir, 'i.sqlite'), rescanMs: 0 });
});
afterEach(() => {
  base.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('qué mensajes miran los apuntes', () => {
  it('/experto con tema y pregunta se convierte en pregunta normal con sus apuntes', () => {
    expect(textoComandoExperto('/experto derecho ¿qué es la usucapión?', ['derecho'])).toBe(
      'según mis apuntes de derecho: ¿qué es la usucapión?',
    );
    expect(textoComandoExperto('/experto ¿qué es la usucapión?', ['derecho'])).toBe(
      'según mis apuntes: ¿qué es la usucapión?',
    );
    expect(textoComandoExperto('/expertos', ['derecho'])).toBeNull();
    expect(textoComandoExperto('/expertos derecho', ['derecho'])).toBeNull();
  });

  it('«según mis apuntes de derecho» es explícito y fija el tema; un saludo no mira nada', () => {
    expect(
      peticionApuntes('Según mis apuntes de derecho, ¿qué es la usucapión?', ['derecho']),
    ).toEqual({
      pregunta: '¿qué es la usucapión?',
      tema: 'derecho',
      explicito: true,
    });
    expect(peticionApuntes('hola', ['derecho'])).toBeNull();
    expect(peticionApuntes('recuérdame comprar pan a las 5', ['derecho'])).toBeNull();
    expect(peticionApuntes('¿Qué obligaciones tiene el arrendatario?', ['derecho'])).toMatchObject({
      explicito: false,
    });
    expect(peticionApuntes('¿qué es la usucapión?', [])).toBeNull();
  });
});

describe('nota de apuntes del turno', () => {
  it('una pregunta que sale en sus apuntes llega con el pasaje y su fuente', async () => {
    const nota = await notaApuntes(base, '¿Qué obligaciones tiene el arrendatario?');
    expect(nota).toContain('<apuntes tema="derecho">');
    expect(nota).toContain('[1] civil.md, Artículo 1555: «');
    expect(nota).toContain('cita cada dato así: (archivo, pág./sección)');
    expect(nota).toContain('Si su mensaje no va de esto, ignora este bloque.');
  });

  it('las instrucciones del tema van en la nota', async () => {
    base.fijarInstrucciones('derecho', 'cita artículos, derecho español');
    expect(await notaApuntes(base, 'según mis apuntes, ¿qué es la usucapión?')).toContain(
      'Instrucciones de derecho: cita artículos, derecho español',
    );
  });

  it('pedido explícito que sus apuntes no cubren: la nota obliga a decirlo', async () => {
    const nota = await notaApuntes(
      base,
      'según mis apuntes de derecho, ¿qué es la hipoteca inversa?',
    );
    expect(nota).toContain('tus apuntes de derecho no lo cubren');
    expect(nota).toContain('(conocimiento general, no está en tus apuntes)');
  });

  it('una pregunta que no va de sus apuntes no añade nada', async () => {
    expect(await notaApuntes(base, '¿Qué tiempo hará mañana en Madrid?')).toBe('');
    expect(await notaApuntes(base, 'hola')).toBe('');
  });
});

describe('«añade esto a derecho» con un archivo', () => {
  it('un tema que existe, o uno nuevo si dice «apuntes»/«tema»', () => {
    expect(temaParaAnadir('añade esto a derecho', ['derecho'])).toBe('derecho');
    expect(temaParaAnadir('Guárdalo en mis apuntes de Penal', ['derecho'])).toBe('Penal');
    expect(temaParaAnadir('mételo en el tema oposiciones', [])).toBe('oposiciones');
  });

  it('frases que no son de apuntes no se tragan el archivo', () => {
    expect(temaParaAnadir('mete esto en la carpeta de fotos', ['derecho'])).toBeNull();
    expect(temaParaAnadir('añade esto a la lista de la compra', ['derecho'])).toBeNull();
    expect(temaParaAnadir('guarda esto en mis documentos', ['derecho'])).toBeNull();
    expect(temaParaAnadir('resume este PDF', ['derecho'])).toBeNull();
    expect(temaParaAnadir(undefined, ['derecho'])).toBeNull();
  });
});

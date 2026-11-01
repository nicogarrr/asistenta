import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { formatRules, ignoraAnswer, rulesAnswer } from '../src/ojo-ignore.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const ojo = readFileSync(new URL('../src/ojo-ignore.ts', import.meta.url), 'utf8');

describe('descartar avisos y reglas de ignorar sin /ignora ni /ignorados', () => {
  it('la explicación del ojo dice cómo descartar en palabras', () => {
    expect(cli).not.toContain('/ignora n lo descarta');
    expect(cli).not.toContain('te propongo una regla (/ignorados)');
    expect(cli).toContain('(por ejemplo «descarta el 3») y no te lo vuelvo a recordar');
    expect(ojo).not.toContain('repite /ignora');
  });

  it('«descarta el 3» descarta el aviso [#3], solo en el chat privado del dueño', () => {
    for (const [t, n] of [
      ['descarta el 3', 3],
      ['Ignora el aviso #12', 12],
      ['descarta el número 7.', 7],
      ['olvídate del 4', null],
      ['descarta el correo de Juan', null],
      ['ignora lo que te dije', null],
    ] as const) {
      expect(ignoraAnswer(t), t).toBe(n);
    }
    expect(cli).toContain(
      'const n = isOwnerDm(inbound, vigilanteOwnerId) ? ignoraAnswer(inbound.text) : null;',
    );
    expect(cli).toContain('if (await ignoraByWords(inbound)) return;');
  });

  it('la lista de reglas pregunta en palabras y entiende «activa la R3» / «borra la 3»', () => {
    const text = formatRules([
      {
        id: 3,
        status: 'propuesta',
        kind: 'pago',
        src: 'correo',
        pattern: 'factura taller',
        dismissed: 2,
      },
    ] as never);
    expect(text).not.toMatch(/\/\w|<id>/);
    expect(text).toContain(
      '¿Activo o borro alguna? Dime, por ejemplo, «activa la R3» o «borra la R3».',
    );
    expect(rulesAnswer('activa la R3')).toBe('activar 3');
    expect(rulesAnswer('borra la 3')).toBe('borrar 3');
    expect(rulesAnswer('quita la regla R12')).toBe('borrar 12');
    expect(rulesAnswer('activa todo')).toBeNull();
    expect(cli).toContain(
      "if (rules.length) preguntas.ask(chatKey(inbound), 'ignorados', { answer: rulesAnswer });",
    );
    const p = new PreguntasPendientes();
    p.ask('c', 'ignorados', { answer: rulesAnswer });
    expect(p.consume('c', 'borra la R3')).toEqual({ name: 'ignorados', args: 'borrar 3' });
  });
});

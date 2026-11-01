import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIRED_BUTTON_STALE } from '../src/tools/reminder.js';
import { watchFromAnswer, watchNotFound } from '../src/watch/pages.js';

// Nico (1 nov): «como estamos hablando nosotros». Quedaban «Mira /vigilando»,
// «Regrábala con /learn», «Puedes crearlas con /routine» y «Mira /recordatorios».
const cli = readFileSync('src/cli.ts', 'utf8');
const list = [
  { id: 'a1b2', label: 'Tele 55', url: 'https://example.com/tele' },
  { id: 'c3d4', label: 'Cafetera', url: 'https://example.com/cafe' },
];

describe('vigilancias, rutinas y recordatorios sin comandos', () => {
  it('un id que no existe nombra las vigilancias que hay', () => {
    expect(watchNotFound(list)).toBe(
      'No encuentro esa vigilancia. Las que tengo: Tele 55 (a1b2), Cafetera (c3d4).',
    );
    expect(watchNotFound([])).toBe('No encuentro esa vigilancia: ahora no vigilo ninguna página.');
    expect(cli).not.toContain('Mira /vigilando');
  });

  it('«dejar de vigilar» sin decir cuál pregunta y entiende «la de la tele»', () => {
    expect(watchFromAnswer(list, 'la de la tele')?.id).toBe('a1b2');
    expect(watchFromAnswer(list, 'Cafetera.')?.id).toBe('c3d4');
    expect(watchFromAnswer(list, 'C3D4')?.id).toBe('c3d4');
    expect(watchFromAnswer(list, 'la de la nevera')).toBeNull();
    expect(watchFromAnswer(list, 'e')).toBeNull();
    expect(cli).toContain('`¿Cuál dejo de vigilar? Tienes: ');
  });

  it('rutinas y recordatorios ya no mandan a un comando', () => {
    const routines = readFileSync('src/routines.ts', 'utf8');
    const cron = readFileSync('src/daemon/cron-command.ts', 'utf8');
    expect(routines).not.toContain('Regrábala con /learn.');
    expect(cron).not.toContain('Puedes crearlas con /routine.');
    expect(FIRED_BUTTON_STALE).toBe(
      'Este botón ya no sirve (vale una vez y 24 horas). Si quieres ver tus recordatorios, pídemelos.',
    );
  });
});

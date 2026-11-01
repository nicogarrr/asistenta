import { describe, expect, it } from 'vitest';
import { validateSchedule } from '../src/routines.js';

// Nico (31 oct): que Asistenta hable como en un chat. Un horario mal escrito
// en /cron contestaba en inglés («schedule must have 5 fields…», el error
// crudo de la librería o «parses but never fires»). Ahora, en castellano llano.
const errorOf = (expr: string): string => {
  const r = validateSchedule(expr);
  return r.ok ? '' : r.error;
};

describe('textos fijos sin jerga (11): horarios', () => {
  it('pocas partes: lo dice en castellano, con un ejemplo', () => {
    expect(errorOf('0 8 *')).toBe(
      'el horario «0 8 *» tiene 3 partes y necesita 5 (minuto hora día mes día-de-la-semana) o 6 con los segundos delante; ejemplo: «0 8 * * *» = cada día a las 8:00',
    );
  });

  it('un número fuera de rango: sin el error en inglés de la librería', () => {
    const msg = errorOf('99 99 * * *');
    expect(msg).toMatch(/^no entiendo el horario «99 99 \* \* \*»: cada parte va en números/);
    expect(msg).not.toMatch(/[Ii]nvalid|pattern|CronPattern/);
  });

  it('un horario que nunca llega', () => {
    expect(errorOf('0 0 30 2 *')).toBe(
      'ese horario nunca llega: no hay ninguna fecha que encaje (por ejemplo, un 30 de febrero)',
    );
  });

  it('ningún texto en inglés llega al chat por /cron', () => {
    for (const expr of ['0 8 *', '99 99 * * *', '0 0 30 2 *']) {
      expect(errorOf(expr)).not.toMatch(/\b(schedule|fields|never|fires|got)\b/);
    }
  });
});

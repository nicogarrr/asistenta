import { describe, expect, it } from 'vitest';
import { friendlyError } from '../src/channels/formatters.js';
import type { Routine } from '../src/db.js';
import { lateReminderText } from '../src/tools/reminder.js';

// Nico (31 oct): que Asistenta hable como en un chat. Los textos fijos que le llegan
// sin pasar por el modelo no deben llevar jerga interna, errores en crudo ni rutas.
const JERGA =
  /\bundefined\b|\bnull\b|\bNaN\b|Error:|TypeError|\bat \S+:\d+|[A-Za-z]:\\|\/home\/|\bturno\b|\bdaemon\b|fetch failed|ECONN|ETIMEDOUT|\{"/;

function routine(name: string, prompt: string): Pick<Routine, 'name' | 'prompt'> {
  return { name, prompt };
}

describe('textos fijos en lenguaje natural', () => {
  it('recordatorio con retraso: frase normal, con «a las»', () => {
    const t = lateReminderText(
      routine('recordatorio-1: comprar pan @2026-11-03 09:00', 'comprar pan'),
    );
    expect(t).toBe('⏰ Te lo recuerdo con retraso, era para el 03/11 a las 09:00: comprar pan');
    expect(t).not.toMatch(JERGA);
  });

  it('recordatorio con retraso sin hora conocida: sin «una hora anterior»', () => {
    const t = lateReminderText(routine('otra cosa', 'llamar a mamá'));
    expect(t).toBe('⏰ Te lo recuerdo con retraso: llamar a mamá');
  });

  const ERRORES: unknown[] = [
    new TypeError('fetch failed'),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    new Error('The operation was aborted due to timeout ETIMEDOUT'),
    new Error('429 Too Many Requests {"error":{"type":"rate_limit"}}'),
    new Error('401 invalid x-api-key'),
    new Error('503 Service Unavailable from model provider'),
    new TypeError("Cannot read properties of undefined (reading 'text')"),
    new Error('boom\n    at run (/home/nico/asistenta/dist/cli.js:12:3)'),
    new Error('{"detail":"something"}'),
    null,
    undefined,
  ];

  for (const err of ERRORES) {
    it(`friendlyError sin jerga: ${String((err as Error | null)?.message ?? err).slice(0, 40)}`, () => {
      const t = friendlyError(err);
      expect(t).not.toMatch(JERGA);
    });
  }
});

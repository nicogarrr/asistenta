import { describe, expect, it } from 'vitest';
import { bootProblemText } from '../src/boot-notice.js';
import { startText, startWelcomeDue } from '../src/channels/telegram-help.js';

describe('arranque limpio (Nico, 31/10 00:43)', () => {
  it('el aviso de arranque (solo si algo falla) es una sola línea, sin modelo ni estado', () => {
    const text = bootProblemText(['modelo']);
    expect(text).not.toContain('\n');
    expect(text).not.toMatch(/Modelo:|Tele:|PC:|Correo:|\/funciones/);
  });

  it('la bienvenida es corta: saludo, cómo usarla y permisos, con una sola pista', () => {
    const text = startText('Nico');
    expect(text.split('\n')).toHaveLength(3);
    expect(text).not.toContain('•');
    expect(text).not.toContain('/funciones');
    expect(text.match(/\/help/g)).toHaveLength(1);
    expect(text).toContain('permiso');
  });

  it('un segundo /start en el mismo chat a los pocos segundos no repite la bienvenida', () => {
    const t0 = Date.parse('2026-10-31T00:42:00Z');
    expect(startWelcomeDue('telegram:42:', t0)).toBe(true);
    expect(startWelcomeDue('telegram:42:', t0 + 3_000)).toBe(false);
    expect(startWelcomeDue('telegram:43:', t0 + 3_000)).toBe(true);
    expect(startWelcomeDue('telegram:42:', t0 + 6 * 60_000)).toBe(true);
  });

  it('un /start guardado con Asistenta apagada no se contesta al arrancar', () => {
    const now = Date.parse('2026-10-31T00:42:00Z');
    expect(startWelcomeDue('telegram:50:', now, '2026-10-31T00:30:00Z')).toBe(false);
    expect(startWelcomeDue('telegram:51:', now, '2026-10-31T00:41:30Z')).toBe(true);
  });
});

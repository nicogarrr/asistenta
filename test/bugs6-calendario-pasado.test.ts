import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { esSiCalendario, preguntaFechaPasada } from '../src/agenda/calendario-pasado.js';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// /calendario «el 2 de noviembre a las 10 dentista» dicho el 2 a las 11: se apuntaba
// sin decir nada y el evento quedaba en el pasado. Ahora pregunta antes.
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-02T10:00:00Z'); // lunes 2 nov, 11:00 en Madrid
const cli = readFileSync('src/cli.ts', 'utf8');

describe('/calendario con una fecha que ya pasó', () => {
  it('pregunta antes de apuntarla', () => {
    const hoy = parseFechaCalendario('el 2 de noviembre a las 10 dentista', NOW, TZ);
    expect(hoy).not.toBeNull();
    expect(preguntaFechaPasada(hoy?.start as Date, NOW, TZ)).toBe(
      'Eso ya ha pasado (hoy a las 10:00). ¿Lo apunto igualmente? Dime «sí», o dime otra fecha.',
    );
    const ayer = new Date('2026-11-01T17:30:00Z');
    expect(preguntaFechaPasada(ayer, NOW, TZ)).toBe(
      'Eso ya ha pasado (el 01/11 a las 18:30). ¿Lo apunto igualmente? Dime «sí», o dime otra fecha.',
    );
    const otroAno = new Date('2025-12-24T20:00:00Z');
    expect(preguntaFechaPasada(otroAno, NOW, TZ)).toContain('(el 24/12/2025 a las 21:00)');
  });

  it('lo que aún no ha llegado se apunta sin preguntar', () => {
    for (const t of [
      'hoy a las 18 dentista',
      'mañana a las 9 ITV',
      'el 2 de noviembre a las 12 pádel',
    ]) {
      const r = parseFechaCalendario(t, NOW, TZ);
      expect(r, t).not.toBeNull();
      expect(preguntaFechaPasada(r?.start as Date, NOW, TZ), t).toBeNull();
    }
    // Un minuto de margen: «hoy a las 11» dicho a las 11:00:30 no es «ya ha pasado».
    expect(
      preguntaFechaPasada(new Date('2026-11-02T10:00:00Z'), new Date('2026-11-02T10:00:30Z'), TZ),
    ).toBeNull();
  });

  it('«sí» lo apunta; otra fecha la cambia', () => {
    for (const t of ['sí', 'Si', 'vale', 'apúntalo', 'igualmente'])
      expect(esSiCalendario(t), t).toBe(true);
    for (const t of ['no', 'mañana a las 10 dentista', 'sí pero mañana'])
      expect(esSiCalendario(t), t).toBe(false);
    expect(cli).toContain('preguntaFechaPasada(start, new Date())');
    expect(cli).toMatch(/`confirmado \$\{start\.toISOString\(\)\} \| \$\{title\}`/);
    expect(cli).toContain('/^(?:add|anadir|añadir|confirmado)\\s+(.+?)\\s*\\|\\s*(.+)$/i');
  });
});

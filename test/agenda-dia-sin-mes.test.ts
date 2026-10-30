import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

function at(
  subject: string,
  nowIso = '2026-10-30T09:00:00Z',
  minConfidence = 0,
): string | undefined {
  const now = Date.parse(nowIso);
  const found = extractCommitments(
    [
      {
        id: 'm',
        from: 'ana@example.com',
        to: [],
        subject,
        text: '',
        at: now,
        seen: false,
        folder: 'INBOX',
      },
    ],
    { now, timeZone: 'Europe/Madrid', minConfidence },
  );
  const first = found[0];
  if (!first) return undefined;
  return new Date(first.at).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
}

describe('«el día 5» sin mes', () => {
  it('es el próximo día 5 (el mes que viene si este ya pasó)', () => {
    expect(at('Reunión el día 5')).toBe('2026-11-05 09:00');
    expect(at('Reunión el día 5 a las 10:30', '2026-10-30T09:00:00Z', 0.6)).toBe(
      '2026-11-05 10:30',
    );
  });

  it('si ese día aún no ha pasado este mes, es este mes (hoy incluido)', () => {
    expect(at('Entrega el día 30')).toBe('2026-10-30 09:00');
    expect(at('Entrega el día 31')).toBe('2026-10-31 09:00');
  });

  it('salta los meses que no tienen ese día', () => {
    expect(at('Pago el día 31', '2026-11-10T09:00:00Z')).toBe('2026-12-31 09:00');
  });

  it('con mes escrito manda el mes; «de cada mes» no es una fecha', () => {
    expect(at('Cita el día 5 de diciembre')).toBe('2026-12-05 09:00');
    expect(at('Pagamos el día 5 de cada mes')).toBeUndefined();
  });

  it('un día imposible no es una fecha', () => {
    expect(at('Reunión el día 32')).toBeUndefined();
    expect(at('Reunión el día 0')).toBeUndefined();
  });
});

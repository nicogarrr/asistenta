import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runVigilanteOnce } = await import('../src/vigilante.js');

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-10-11T10:00:00+02:00').getTime();
const DAY = 86_400_000;

function agendaWith(title: string): UnifiedAgenda {
  const item: AgendaItem = { at: NOW + DAY, kind: 'deadline', where: 'correo', title };
  return {
    today: [],
    upcoming: [item],
    pending: [],
    generatedAt: NOW,
    days: 7,
    counts: { calendar: 0, mail: 1, pending: 0 },
    notes: [],
  };
}

/**
 * Las marcas de «ya avisado» tras un envío confirmado no eran una transacción: un error
 * de sqlite a mitad dejaba el aviso visto pero sin el resto de marcas.
 */
describe('vigilante: marcas tras el envío, todo o nada', () => {
  it('un fallo a mitad no deja nada marcado y el siguiente barrido lo reintenta entero', async () => {
    const db = new DatabaseSync(':memory:');
    const ok = vi.fn(async (_text: string) => true);
    const deps = { db, agenda: async () => agendaWith('Renovar DNI'), send: ok, now: () => NOW };
    await runVigilanteOnce(deps, TZ); // crea las tablas
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON vigilante_stages BEGIN SELECT RAISE(ABORT, 'disco lleno'); END;
             CREATE TRIGGER boom2 BEFORE UPDATE ON vigilante_notices BEGIN SELECT RAISE(ABORT, 'disco lleno'); END;`);
    const seen = () =>
      (
        db.prepare("SELECT count(*) c FROM vigilante_seen WHERE title = 'Pagar el IBI'").get() as {
          c: number;
        }
      ).c;
    const ibi = { ...deps, agenda: async () => agendaWith('Pagar el IBI') };

    // El barrido atrapa el error y lo deja para el siguiente ciclo.
    expect(await runVigilanteOnce(ibi, TZ)).toMatchObject({ notified: 0 });
    expect(seen()).toBe(0);
    expect(db.isTransaction).toBe(false);

    db.exec('DROP TRIGGER boom; DROP TRIGGER boom2;');
    ok.mockClear();
    expect(await runVigilanteOnce(ibi, TZ)).toMatchObject({ notified: 1 });
    expect(String(ok.mock.calls[0]?.[0])).toContain('Pagar el IBI');
    expect(seen()).toBe(1);
    // Y una vez marcado de verdad, no se repite.
    ok.mockClear();
    expect(await runVigilanteOnce(ibi, TZ)).toMatchObject({ notified: 0 });
    expect(ok).not.toHaveBeenCalled();
  });
});

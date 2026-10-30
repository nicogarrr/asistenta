import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runVigilanteOnce, startVigilanteLoop } = await import('../src/vigilante.js');

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

const hang = () => new Promise<boolean>(() => {});

async function settles<T>(p: Promise<T>, ms: number): Promise<T | 'colgado'> {
  return Promise.race([p, new Promise<'colgado'>((r) => setTimeout(() => r('colgado'), ms))]);
}

/**
 * Un envío de Telegram que no responde nunca bloqueaba la cadena de barridos
 * (serializada por base de datos) y el drain de stop(): el daemon no cerraba.
 */
describe('vigilante: plazo al envío del aviso', () => {
  it('un envío colgado vence, no marca nada y el siguiente barrido reintenta', async () => {
    const db = new DatabaseSync(':memory:');
    const send = vi.fn(hang);
    const deps = {
      db,
      agenda: async () => agendaWith('Pagar el IBI'),
      send,
      now: () => NOW,
      sendTimeoutMs: 50,
    };
    const first = await settles(runVigilanteOnce(deps, TZ), 1500);
    expect(first).not.toBe('colgado');
    expect(first).toMatchObject({ notified: 0 });

    // Nada quedó marcado como avisado: el mismo hallazgo se vuelve a intentar.
    const ok = vi.fn(async (_text: string) => true);
    const second = await settles(runVigilanteOnce({ ...deps, send: ok }, TZ), 1500);
    expect(second).toMatchObject({ notified: 1 });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(String(ok.mock.calls[0]?.[0])).toContain('Pagar el IBI');
  });

  it('stop() del bucle termina aunque el envío en vuelo no responda', async () => {
    const db = new DatabaseSync(':memory:');
    const send = vi.fn(hang);
    const loop = startVigilanteLoop(
      {
        db,
        agenda: async () => agendaWith('Renovar DNI'),
        send,
        now: () => NOW,
        sendTimeoutMs: 50,
      },
      TZ,
      60_000,
      0,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 1500 });
    expect(await settles(loop.stop(), 1500)).not.toBe('colgado');
  });
});

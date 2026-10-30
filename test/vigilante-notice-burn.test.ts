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

const nums = (text: string) => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

async function numbersAfterFailedSend(failing: (text: string) => Promise<boolean>) {
  const db = new DatabaseSync(':memory:');
  const deps = {
    db,
    agenda: async () => agendaWith('Pagar el IBI'),
    now: () => NOW,
    sendTimeoutMs: 50,
  };
  const first = vi.fn(failing);
  await runVigilanteOnce({ ...deps, send: first }, TZ);
  const ok = vi.fn(async (_text: string) => true);
  const res = await runVigilanteOnce({ ...deps, send: ok }, TZ);
  expect(res).toMatchObject({ notified: 1 });
  return {
    before: nums(String(first.mock.calls[0]?.[0])),
    after: nums(String(ok.mock.calls[0]?.[0])),
  };
}

/**
 * Un envío vencido o con error puede haber salido (o salir tarde) con sus [#N]. Si el
 * número se reutilizaba, /ignora N de ese aviso tardío descartaba otro aviso distinto.
 */
describe('vigilante: números de aviso con envío de resultado desconocido', () => {
  it('plazo vencido: el reintento no reutiliza los números', async () => {
    const { before, after } = await numbersAfterFailedSend(() => new Promise<boolean>(() => {}));
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    for (const n of after) expect(before).not.toContain(n);
  });

  it('envío que lanza error: el reintento no reutiliza los números', async () => {
    const { before, after } = await numbersAfterFailedSend(async () => {
      throw new Error('red caída');
    });
    expect(before.length).toBeGreaterThan(0);
    for (const n of after) expect(before).not.toContain(n);
  });

  it('«no enviado» explícito: se reutilizan los mismos números', async () => {
    const { before, after } = await numbersAfterFailedSend(async () => false);
    expect(after).toEqual(before);
  });
});

import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';
import { findingKey, formatFindings, runVigilanteOnce } from '../src/vigilante.js';

const T = 'Europe/Madrid',
  N = Date.parse('2026-10-12T10:00:00+02:00');
const item = (i: number): AgendaItem => ({
  title: `Plazo ${i}`,
  kind: 'deadline',
  where: 'correo',
  at: N + i * 1000,
});
const agenda = (items: AgendaItem[]): UnifiedAgenda => ({
  today: [],
  upcoming: items,
  pending: [],
  notes: [],
  days: 7,
  generatedAt: N,
  counts: { calendar: 0, mail: items.length, pending: 0 },
});
it('sixth fresh finding is delivered on next sweep', async () => {
  const db = new DatabaseSync(':memory:');
  const d = {
    db,
    agenda: async () => agenda(Array.from({ length: 6 }, (_, i) => item(i))),
    send: async () => true,
  };
  expect((await runVigilanteOnce(d, T)).notified).toBe(5);
  expect((await runVigilanteOnce(d, T)).notified).toBe(1);
});
it('all day and untimed findings have no invented midnight', () => {
  expect(
    formatFindings(
      [{ ...item(1), timed: false, allDay: true, at: Date.parse('2026-10-13T00:00:00+02:00') }],
      T,
    ),
  ).not.toContain('0:00');
});
it('one local calendar day is one key across UTC boundary', () => {
  const a = { ...item(1), at: Date.parse('2026-10-13T00:30:00+02:00') },
    b = { ...a, at: Date.parse('2026-10-13T14:00:00+02:00') };
  expect(findingKey(a)).toBe(findingKey(b));
});
it('dated pending commitment is not silently omitted', async () => {
  const db = new DatabaseSync(':memory:');
  const a = { ...agenda([]), pending: [{ ...item(1), where: 'pendiente' as const }] };
  expect(
    (await runVigilanteOnce({ db, agenda: async () => a, send: async () => true }, T)).notified,
  ).toBe(1);
});
it('stop during pending agenda prevents later notification', async () => {
  const { startVigilanteLoop } = await import('../src/vigilante.js');
  let resolve!: (a: UnifiedAgenda) => void;
  let calls = 0;
  const p = new Promise<UnifiedAgenda>((r) => {
    resolve = r;
  });
  const db = new DatabaseSync(':memory:');
  const loop = startVigilanteLoop(
    {
      db,
      agenda: () => p,
      send: async () => {
        calls++;
        return true;
      },
    },
    T,
    1000,
    0,
  );
  await new Promise((r) => setTimeout(r, 5));
  loop.stop();
  resolve(agenda([item(1)]));
  await new Promise((r) => setTimeout(r, 10));
  expect(calls).toBe(0);
});
it('duplicate keys within sweep only sent once', async () => {
  const db = new DatabaseSync(':memory:');
  expect(
    (
      await runVigilanteOnce(
        { db, agenda: async () => agenda([item(1), item(1)]), send: async () => true },
        T,
      )
    ).notified,
  ).toBe(1);
});

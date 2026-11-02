import { describe, expect, it, vi } from 'vitest';
import { composeDailyBriefing, type DailyBriefingDeps } from '../src/briefing-daily.js';
import { createProximoFestivo } from '../src/festivos-rutinas.js';

const nager = [
  { date: '2026-12-08', localName: 'Inmaculada Concepción', global: true, counties: null },
  { date: '2026-12-25', localName: 'Navidad', global: true, counties: null },
];
const ok = () =>
  vi.fn(
    async () => new Response(JSON.stringify(nager), { status: 200 }),
  ) as unknown as typeof fetch;

describe('briefing: festivo o puente de la semana en una línea (festivos1)', () => {
  it('el primer festivo entre semana de los próximos 7 días, con su puente', async () => {
    const next = createProximoFestivo({ fetchFn: ok(), env: {} });
    expect(await next(new Date('2026-12-03T08:00:00+01:00'))).toBe(
      'Festivo el martes 8 de diciembre (Inmaculada Concepción): puente si coges el lunes 7 de diciembre.',
    );
    expect(await next(new Date('2026-12-10T08:00:00+01:00'))).toBeNull();
  });

  const base = (extra: Partial<DailyBriefingDeps>): DailyBriefingDeps =>
    ({
      enabled: () => true,
      now: () => new Date('2026-12-03T08:00:00+01:00'),
      lastSent: () => 0,
      markSent: () => {},
      owner: () => '1',
      send: async () => true,
      reminders: () => [{ text: 'llamar al banco', when: '10:00' }],
      festivo: async () => 'Festivo el martes 8 de diciembre (Inmaculada Concepción).',
      ...extra,
    }) as unknown as DailyBriefingDeps;

  it('con calendario, va como una línea más de «Hoy»', async () => {
    const { text } = await composeDailyBriefing(
      base({ agenda: async () => [{ title: 'Dentista', when: '17:00' }] }),
    );
    expect(text).toContain('Festivo el martes 8 de diciembre');
    expect(text.indexOf('Dentista')).toBeLessThan(text.indexOf('Festivo el martes'));
  });

  it('sin calendario en el briefing, no aparece', async () => {
    const { text } = await composeDailyBriefing(base({}));
    expect(text).not.toContain('Festivo');
  });
});

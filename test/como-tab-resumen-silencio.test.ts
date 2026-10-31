import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetDailyBriefingForTests,
  type DailyBriefingDeps,
  runDailyBriefingIfDue,
} from '../src/briefing-daily.js';
import { briefingHourFor } from '../src/daemon/briefing-quiet.js';
import { ownerQuietHours } from '../src/memory/owner-quiet.js';

/**
 * Como Tab: si el dueño dijo «no me escribas antes de las 10», el resumen de las 8 no
 * le despierta: sale a las 10. Sin nada dicho, la hora del resumen no se toca.
 */
const said = (s: string) => `[dicho] ${s}`;
const at = (hour: number, minute = 0) => new Date(2026, 9, 30, hour, minute, 0, 0);

afterEach(() => _resetDailyBriefingForTests());

describe('hora del resumen y horas de silencio del dueño', () => {
  it('sin nada dicho: la de siempre, aunque caiga en el silencio de serie', () => {
    expect(briefingHourFor(undefined, [])).toBe(8);
    expect(briefingHourFor(7, [])).toBe(7);
    expect(briefingHourFor(7, ['[auto] No me escribas antes de las 10'])).toBe(7);
  });

  it('«no me escribas antes de las 10» lo pasa a las 10', () => {
    expect(briefingHourFor(undefined, [said('No me escribas antes de las 10')])).toBe(10);
    expect(briefingHourFor(9, [said('No me molestes antes de las 9 y media')])).toBe(10);
  });

  it('fuera del silencio no se mueve', () => {
    expect(briefingHourFor(undefined, [said('No me escribas antes de las 7')])).toBe(8);
    expect(briefingHourFor(8, [said('No me mandes nada después de las 11')])).toBe(8);
  });

  it('el silencio de serie sigue igual con lo dicho', () => {
    expect(ownerQuietHours([said('No me escribas antes de las 10')])).toEqual({
      startHour: 22,
      endHour: 10,
    });
  });

  it('con reloj falso: a las 8:30 no sale, a las 10:05 sí', async () => {
    let now = at(8, 30);
    let last = 0;
    const sent: string[] = [];
    const entries = [said('No me escribas antes de las 10')];
    const d: DailyBriefingDeps = {
      enabled: () => true,
      now: () => now,
      get hour() {
        return briefingHourFor(undefined, entries);
      },
      lastSent: () => last,
      markSent: (ms) => {
        last = ms;
      },
      owner: () => '42',
      send: async (_chat, text) => {
        sent.push(text);
        return true;
      },
      agenda: async () => [{ title: 'Dentista', when: '11:30' }],
      sourceTimeoutMs: 50,
    };
    expect((await runDailyBriefingIfDue(d)).status).toBe('not-due');
    now = at(10, 5);
    expect((await runDailyBriefingIfDue(d)).status).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('el daemon usa lo dicho por el dueño para la hora del resumen', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    const deps = cli.slice(
      cli.indexOf('const briefingDeps'),
      cli.indexOf('lastSent:', cli.indexOf('const briefingDeps')),
    );
    expect(deps).toContain('briefingHourFor(');
  });
});

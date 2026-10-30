import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDailyBriefingForTests,
  BRIEFING_CHECK_EVERY_MS,
  type DailyBriefingDeps,
  startDailyBriefingTimer,
} from '../src/briefing-daily.js';

// Reloj falso: nada espera de verdad ni sale a la red.
function deps(over: Partial<DailyBriefingDeps> = {}) {
  let last = 0;
  const sent: string[] = [];
  const d: DailyBriefingDeps = {
    enabled: () => true,
    now: () => new Date(),
    hour: 8,
    lastSent: () => last,
    markSent: (at) => {
      last = at;
    },
    owner: () => '4242',
    send: async (_chat, text) => {
      sent.push(text);
      return true;
    },
    reminders: () => [{ text: 'Llamar al banco' }],
    warn: () => {},
    ...over,
  };
  return { d, sent };
}

describe('resumen diario: se mira cada minuto, no cada 2 h', () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    _resetDailyBriefingForTests();
    vi.useFakeTimers();
    // 09:30 UTC = 10:30 en Madrid: el PC arranca tarde, pero antes de las 12.
    vi.setSystemTime(new Date('2026-10-30T09:30:00Z'));
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('mira cada minuto', () => {
    expect(BRIEFING_CHECK_EVERY_MS).toBeLessThanOrEqual(60_000);
  });

  it('el PC arranca a las 10:30: el resumen sale en el primer minuto y solo una vez', async () => {
    const { d, sent } = deps();
    stop = startDailyBriefingTimer(d);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Llamar al banco');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it('parar el reloj corta las comprobaciones', async () => {
    const enabled = vi.fn(() => false);
    const { d } = deps({ enabled });
    stop = startDailyBriefingTimer(d);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    const n = enabled.mock.calls.length;
    expect(n).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(enabled.mock.calls.length).toBe(n);
  });

  it('un fallo al comprobar se avisa y no tumba el reloj', async () => {
    const warn = vi.fn();
    let calls = 0;
    const { d } = deps({
      warn,
      owner: () => {
        calls += 1;
        throw new Error('db rota');
      },
    });
    stop = startDailyBriefingTimer(d);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledWith('briefing: comprobación falló', { err: 'Error: db rota' });
  });

  it('el daemon usa este reloj y no el de 2 h de las vigilancias', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('startDailyBriefingTimer(briefingDeps)');
    expect(cli).not.toMatch(/runDailyBriefingIfDue\(briefingDeps\)/);
  });
});

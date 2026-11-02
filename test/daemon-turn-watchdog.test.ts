import { describe, expect, it } from 'vitest';
import {
  parseVerdict,
  TurnWatchdog,
  turnWatchdogScan,
  verdictPrompt,
  WATCHDOG_MIN_TURN_MS,
  WATCHDOG_RECENT_STEPS,
  WATCHDOG_SUSPECT_MS,
} from '../src/daemon/turn-watchdog.js';

const T0 = 1_000_000_000;

describe('TurnWatchdog (sospecha determinista)', () => {
  it('un turno joven nunca es sospechoso', () => {
    const w = new TurnWatchdog();
    w.begin('t', T0);
    w.note('t', 'leyendo', T0 + 10_000);
    expect(w.suspect('t', T0 + WATCHDOG_MIN_TURN_MS - 1)).toBe(false);
  });

  it('con actividad reciente no hay sospecha aunque el turno sea largo', () => {
    const w = new TurnWatchdog();
    w.begin('t', T0);
    w.note('t', 'trabajando', T0 + WATCHDOG_MIN_TURN_MS + 1_000);
    expect(w.suspect('t', T0 + WATCHDOG_MIN_TURN_MS + WATCHDOG_SUSPECT_MS - 1)).toBe(false);
  });

  it('turno maduro y sin actividad desde hace rato: sospecha', () => {
    const w = new TurnWatchdog();
    w.begin('t', T0);
    w.note('t', 'npm test', T0 + 5_000);
    expect(w.suspect('t', T0 + WATCHDOG_SUSPECT_MS + 10_000)).toBe(true);
  });

  it('esperar una aprobación del dueño NO es estar atascado', () => {
    const w = new TurnWatchdog();
    w.begin('t', T0);
    w.note('t', 'pido permiso', T0 + 5_000);
    w.awaiting('t', true);
    expect(w.suspect('t', T0 + WATCHDOG_SUSPECT_MS + 10_000)).toBe(false);
    w.awaiting('t', false);
    expect(w.suspect('t', T0 + WATCHDOG_SUSPECT_MS + 10_000)).toBe(true);
  });

  it('un turno ya juzgado no se vuelve a juzgar', () => {
    const w = new TurnWatchdog();
    w.begin('t', T0);
    w.markJudged('t');
    expect(w.suspect('t', T0 + WATCHDOG_SUSPECT_MS + 10_000)).toBe(false);
  });

  it('end olvida el turno', () => {
    const w = new TurnWatchdog();
    w.begin('t', T0);
    w.end('t');
    expect(w.suspect('t', T0 + WATCHDOG_SUSPECT_MS + 10_000)).toBe(false);
    expect(w.state('t')).toBeUndefined();
  });

  it(`solo recuerda los últimos ${WATCHDOG_RECENT_STEPS} pasos`, () => {
    const w = new TurnWatchdog();
    w.begin('t', T0);
    for (let i = 0; i < WATCHDOG_RECENT_STEPS + 5; i++) w.note('t', `paso ${i}`, T0 + i);
    const steps = w.state('t')?.steps ?? [];
    expect(steps).toHaveLength(WATCHDOG_RECENT_STEPS);
    expect(steps[steps.length - 1]).toBe(`paso ${WATCHDOG_RECENT_STEPS + 4}`);
  });
});

describe('verdictPrompt / parseVerdict', () => {
  it('el prompt lleva los pasos y los minutos', () => {
    const p = verdictPrompt(['leo cli.ts', 'corro tests'], 7);
    expect(p).toContain('1. leo cli.ts');
    expect(p).toContain('2. corro tests');
    expect(p).toContain('7 minutos');
  });

  it('parsea veredictos estrictos y rechaza ruido', () => {
    expect(parseVerdict('{"progresa": true}')).toBe(true);
    expect(parseVerdict('{"progresa": false}')).toBe(false);
    expect(parseVerdict('```json\n{"progresa": false}\n```')).toBe(false);
    expect(parseVerdict('creo que está atascado')).toBeNull();
    expect(parseVerdict('{"progresa": "true"}')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

describe('turnWatchdogScan (fase 2 con juicio inyectado)', () => {
  const setup = () => {
    const w = new TurnWatchdog();
    w.begin('t1', T0);
    w.note('t1', 'npm test falla', T0 + 1_000);
    return w;
  };
  const later = T0 + WATCHDOG_SUSPECT_MS + 10_000;

  it('atascado: un aviso y solo uno', async () => {
    const w = setup();
    const told: string[] = [];
    const deps = {
      judge: async () => false,
      tell: async (_k: string, text: string) => {
        told.push(text);
      },
      now: () => later,
    };
    expect(await turnWatchdogScan(w, ['t1'], deps)).toBe(1);
    expect(await turnWatchdogScan(w, ['t1'], deps)).toBe(0);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('/stop');
    expect(told[0]).toContain('npm test falla');
  });

  it('progresa: silencio', async () => {
    const w = setup();
    const told: string[] = [];
    const judged = await turnWatchdogScan(w, ['t1'], {
      judge: async () => true,
      tell: async () => {
        told.push('x');
      },
      now: () => later,
    });
    expect(judged).toBe(1);
    expect(told).toHaveLength(0);
  });

  it('juicio ilegible o fallo: silencio (un falso aviso es peor)', async () => {
    const w = setup();
    const told: string[] = [];
    const judged = await turnWatchdogScan(w, ['t1'], {
      judge: async () => null,
      tell: async () => {
        told.push('x');
      },
      now: () => later,
    });
    expect(judged).toBe(1);
    expect(told).toHaveLength(0);
  });

  it('judge que lanza: no rompe la pasada ni avisa', async () => {
    const w = setup();
    const told: string[] = [];
    const judged = await turnWatchdogScan(w, ['t1'], {
      judge: async () => {
        throw new Error('red');
      },
      tell: async () => {
        told.push('x');
      },
      now: () => later,
    });
    expect(judged).toBe(1);
    expect(told).toHaveLength(0);
  });

  it('sin sospecha determinista no hay llamada al modelo', async () => {
    const w = new TurnWatchdog();
    w.begin('t1', T0);
    w.note('t1', 'recién hecho', later - 1_000);
    let calls = 0;
    const judged = await turnWatchdogScan(w, ['t1'], {
      judge: async () => {
        calls += 1;
        return false;
      },
      tell: async () => {},
      now: () => later,
    });
    expect(judged).toBe(0);
    expect(calls).toBe(0);
  });
});

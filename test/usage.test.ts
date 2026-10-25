import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Acumulador de uso y coste.
 *
 * `paths.ts` congela PA_STATE_DIR al importarse, asi que el directorio temporal
 * se prepara antes del import dinamico de usage.ts (mismo patron que budget.test).
 * Cada test arranca con el directorio de log limpio y sin precios de entorno.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-usage-'));
const logDir = join(stateDir, 'log');
process.env.PA_STATE_DIR = stateDir;

const PRICE_KEYS = [
  'PA_PRICE_INPUT_PER_MTOK',
  'PA_PRICE_OUTPUT_PER_MTOK',
  'PA_CONTEXT_WINDOW',
  'PA_MAX_OUTPUT_TOKENS',
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of PRICE_KEYS) {
  savedEnv.set(key, process.env[key]);
  delete process.env[key];
}

const usage = await import('../src/core/usage.js');
const { resolveModelCaps } = await import('../src/core/models.js');

afterAll(() => {
  for (const key of PRICE_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.PA_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(logDir, { recursive: true, force: true });
  for (const key of PRICE_KEYS) delete process.env[key];
});

describe('recordUsage / usageToday / usageForSession', () => {
  it('registra tokens y los agrega por dia y por sesion', () => {
    usage.recordUsage({
      sessionId: 's1',
      model: 'space-bunny-free',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      kind: 'turn',
    });
    usage.recordUsage({
      sessionId: 's2',
      model: 'space-bunny-free',
      inputTokens: 10,
      outputTokens: 2,
      kind: 'summary',
    });

    const today = usage.usageToday();
    expect(today.inputTokens).toBe(1010);
    expect(today.outputTokens).toBe(202);
    expect(today.cacheReadTokens).toBe(50);
    expect(today.totalTokens).toBe(1262);
    expect(today.costEur).toBe(0);
    expect(today.calls).toBe(2);

    const s1 = usage.usageForSession('s1');
    expect(s1).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      totalTokens: 1250,
      calls: 1,
    });

    // Una sesion no ve el consumo de otra, y una desconocida es cero.
    expect(usage.usageForSession('s2').inputTokens).toBe(10);
    expect(usage.usageForSession('no-existe')).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costEur: 0,
      calls: 0,
    });
  });

  it('suma coste con los precios del entorno y redondea a centimos', () => {
    process.env.PA_PRICE_INPUT_PER_MTOK = '2';
    process.env.PA_PRICE_OUTPUT_PER_MTOK = '8';

    usage.recordUsage({
      sessionId: 'coste',
      model: 'modelo-de-pago',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      kind: 'turn',
    });
    usage.recordUsage({
      sessionId: 'coste',
      model: 'modelo-de-pago',
      inputTokens: 500_000,
      outputTokens: 0,
      kind: 'summary',
    });

    // 1M*2 + 0.5M*8 = 6 EUR; 0.5M*2 = 1 EUR.
    expect(usage.usageToday().costEur).toBe(7);
    expect(usage.usageForSession('coste').costEur).toBe(7);
  });

  it('no pierde llamadas de menos de un centimo al acumular', () => {
    process.env.PA_PRICE_INPUT_PER_MTOK = '2';
    // 100 llamadas de 100 tokens a 2 EUR/M = 100 * 0,0002 = 0,02 EUR.
    // Si cada linea se sumara ya redondeada, el total seria 0,00.
    for (let i = 0; i < 100; i += 1) {
      usage.recordUsage({
        sessionId: 'micro',
        model: 'modelo-de-pago',
        inputTokens: 100,
        outputTokens: 0,
        kind: 'turn',
      });
    }
    expect(usage.usageToday().costEur).toBe(0.02);
    expect(usage.dailyBudgetExceeded(0.01)).toBe(true);
  });

  it('eurFor cobra cache como entrada y redondea a centimos', () => {
    process.env.PA_PRICE_INPUT_PER_MTOK = '2';
    process.env.PA_PRICE_OUTPUT_PER_MTOK = '8';
    const caps = resolveModelCaps({ model: 'modelo-de-pago' });

    expect(
      usage.eurFor({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }, caps),
    ).toBe(2);
    expect(
      usage.eurFor({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }, caps),
    ).toBe(8);
    expect(
      usage.eurFor({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, caps),
    ).toBe(2);
    // 100 tokens de entrada a 2 EUR/M son 0,0002 EUR: se muestra como 0,00.
    expect(usage.eurFor({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 0 }, caps)).toBe(0);
  });
});

describe('config PA_DAILY_BUDGET_EUR', () => {
  it('default 0, acepta >= 0 y rechaza negativos', async () => {
    const { loadConfig, resetConfigForTests } = await import('../src/config.js');
    const previous = process.env.PA_DAILY_BUDGET_EUR;
    try {
      delete process.env.PA_DAILY_BUDGET_EUR;
      resetConfigForTests();
      expect(loadConfig().dailyBudgetEur).toBe(0);

      process.env.PA_DAILY_BUDGET_EUR = '2.5';
      resetConfigForTests();
      expect(loadConfig().dailyBudgetEur).toBe(2.5);

      process.env.PA_DAILY_BUDGET_EUR = '-1';
      resetConfigForTests();
      expect(() => loadConfig()).toThrow(/PA_DAILY_BUDGET_EUR/);
    } finally {
      if (previous === undefined) delete process.env.PA_DAILY_BUDGET_EUR;
      else process.env.PA_DAILY_BUDGET_EUR = previous;
      resetConfigForTests();
    }
  });
});

describe('dailyBudgetExceeded', () => {
  it('0, undefined o negativo desactivan el limite', () => {
    process.env.PA_PRICE_INPUT_PER_MTOK = '10';
    usage.recordUsage({
      sessionId: 'presupuesto',
      model: 'modelo-de-pago',
      inputTokens: 1_000_000,
      outputTokens: 0,
      kind: 'turn',
    });
    expect(usage.dailyBudgetExceeded()).toBe(false);
    expect(usage.dailyBudgetExceeded(0)).toBe(false);
    expect(usage.dailyBudgetExceeded(-1)).toBe(false);
    expect(usage.dailyBudgetExceeded(Number.NaN)).toBe(false);
  });

  it('solo se excede al superar el tope, no al igualarlo', () => {
    process.env.PA_PRICE_INPUT_PER_MTOK = '10';
    usage.recordUsage({
      sessionId: 'presupuesto',
      model: 'modelo-de-pago',
      inputTokens: 100_000,
      outputTokens: 0,
      kind: 'turn',
    });
    expect(usage.usageToday().costEur).toBe(1);
    expect(usage.dailyBudgetExceeded(2)).toBe(false);
    expect(usage.dailyBudgetExceeded(1)).toBe(false);
    expect(usage.dailyBudgetExceeded(0.99)).toBe(true);
  });
});

describe('persistencia JSONL', () => {
  it('escribe un fichero por dia local con una linea por registro', () => {
    const day = usage.localDay();
    usage.recordUsage({
      sessionId: 's-file',
      model: 'space-bunny-free',
      inputTokens: 10,
      outputTokens: 3,
      kind: 'extraction',
    });

    const file = join(logDir, `usage-${day}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({
      day,
      sessionId: 's-file',
      model: 'space-bunny-free',
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 0,
      kind: 'extraction',
      costEur: 0,
    });
    expect(typeof record.ts).toBe('string');
  });

  it('usageToday solo mira el dia actual y usageForSession cruza dias', () => {
    const day = usage.localDay();
    usage.recordUsage({
      sessionId: 's-file',
      model: 'space-bunny-free',
      inputTokens: 10,
      outputTokens: 3,
      kind: 'turn',
    });
    // Un dia anterior escrito con el mismo formato (por ejemplo, antes de un reinicio).
    writeFileSync(
      join(logDir, 'usage-2000-01-01.jsonl'),
      `${JSON.stringify({
        ts: '2000-01-01T10:00:00.000Z',
        day: '2000-01-01',
        sessionId: 's-file',
        model: 'space-bunny-free',
        inputTokens: 5,
        outputTokens: 1,
        cacheReadTokens: 0,
        kind: 'turn',
        costEur: 0.25,
      })}\n`,
    );

    expect(usage.usageToday().inputTokens).toBe(10);
    expect(existsSync(join(logDir, `usage-${day}.jsonl`))).toBe(true);
    const session = usage.usageForSession('s-file');
    expect(session.inputTokens).toBe(15);
    expect(session.outputTokens).toBe(4);
    expect(session.calls).toBe(2);
    expect(session.costEur).toBe(0.25);
  });

  it('tolera lineas JSON corruptas y registros con forma invalida', () => {
    usage.recordUsage({
      sessionId: 's-ok',
      model: 'space-bunny-free',
      inputTokens: 7,
      outputTokens: 1,
      kind: 'turn',
    });
    const file = join(logDir, `usage-${usage.localDay()}.jsonl`);
    appendFileSync(file, '{esto no es json\n');
    appendFileSync(file, '{"sessionId":42,"inputTokens":"x"}\n');
    appendFileSync(file, '["tampoco","es","un","registro"]\n');

    // Las lineas rotas no aportan nada y tampoco tumban lo ya escrito.
    const today = usage.usageToday();
    expect(today.calls).toBe(1);
    expect(today.inputTokens).toBe(7);

    const old = join(logDir, 'usage-1999-12-31.jsonl');
    writeFileSync(
      old,
      `basura\n${JSON.stringify({
        sessionId: 's-vieja',
        model: 'space-bunny-free',
        inputTokens: 3,
        outputTokens: 1,
        kind: 'turn',
      })}\n`,
    );
    expect(usage.usageForSession('s-vieja').inputTokens).toBe(3);
  });

  it('nunca lanza si no puede escribir el fichero', () => {
    mkdirSync(logDir, { recursive: true });
    // Un directorio con el nombre del fichero hace fallar appendFileSync.
    mkdirSync(join(logDir, `usage-${usage.localDay()}.jsonl`));
    expect(() =>
      usage.recordUsage({
        sessionId: 's-sin-disco',
        model: 'space-bunny-free',
        inputTokens: 1,
        outputTokens: 1,
        kind: 'turn',
      }),
    ).not.toThrow();
    expect(usage.usageToday().calls).toBe(0);
  });
});

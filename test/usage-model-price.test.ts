import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

/**
 * PA_PRICE_* describen PA_MODEL. Un turno con otro modelo (/modelo, respaldo,
 * PA_MODELS) se cobraba con esos precios. `paths.ts` congela PA_STATE_DIR al
 * importarse: se prepara antes del import.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-usage-price-'));
process.env.PA_STATE_DIR = stateDir;
const usage = await import('../src/core/usage.js');
const models = await import('../src/core/models.js');

const OTHER = 'deepseek-v4.1-flash-free';
const saved = {
  model: process.env.PA_MODEL,
  inp: process.env.PA_PRICE_INPUT_PER_MTOK,
  out: process.env.PA_PRICE_OUTPUT_PER_MTOK,
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv('PA_MODEL', saved.model);
  setEnv('PA_PRICE_INPUT_PER_MTOK', saved.inp);
  setEnv('PA_PRICE_OUTPUT_PER_MTOK', saved.out);
});
afterAll(() => {
  delete process.env.PA_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

function catalogCost(model: string): number {
  const caps = models.resolveModelCaps({ model }, { envOverrides: false });
  return Math.round(caps.inputPerMTok * 1_000_000 + caps.outputPerMTok * 1_000_000);
}

describe('coste por modelo: PA_PRICE_* solo para PA_MODEL', () => {
  it('otro modelo (priceOverrides false) se cobra con su ficha del catálogo', () => {
    process.env.PA_MODEL = 'mi-modelo-principal';
    process.env.PA_PRICE_INPUT_PER_MTOK = '1000';
    process.env.PA_PRICE_OUTPUT_PER_MTOK = '2000';
    const r = usage.recordUsage({
      sessionId: 's1',
      model: OTHER,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      kind: 'turn',
      priceOverrides: false,
    });
    expect(r.costMicros).toBe(catalogCost(OTHER));
    expect(r.costEur).not.toBe(3000);
  });

  it('sin indicar: un modelo distinto de PA_MODEL no usa PA_PRICE_*', () => {
    process.env.PA_MODEL = 'mi-modelo-principal';
    process.env.PA_PRICE_INPUT_PER_MTOK = '1000';
    const r = usage.recordUsage({
      sessionId: 's2',
      model: OTHER,
      inputTokens: 1_000_000,
      outputTokens: 0,
      kind: 'turn',
    });
    expect(r.costEur).not.toBe(1000);
  });

  it('PA_MODEL sigue usando PA_PRICE_*', () => {
    process.env.PA_MODEL = OTHER;
    process.env.PA_PRICE_INPUT_PER_MTOK = '1000';
    const r = usage.recordUsage({
      sessionId: 's3',
      model: OTHER,
      inputTokens: 1_000_000,
      outputTokens: 0,
      kind: 'turn',
    });
    expect(r.costEur).toBe(1000);
    const forced = usage.recordUsage({
      sessionId: 's4',
      model: 'otro',
      inputTokens: 1_000_000,
      outputTokens: 0,
      kind: 'turn',
      priceOverrides: true,
    });
    expect(forced.costEur).toBe(1000);
  });

  it('el daemon registra el modelo real de la conversación (/modelo), no siempre PA_MODEL', () => {
    const cli = readFileSync(join(import.meta.dirname, '../src/cli.ts'), 'utf8');
    const block = cli.slice(cli.indexOf('recordUsage({'), cli.indexOf('recordUsage({') + 200);
    expect(block).not.toContain('model: config.model,');
    expect(cli).toContain('const usedModel = thread.agent.modelId;');
    expect(block).toContain('priceOverrides: usedModel === config.model');
  });
});

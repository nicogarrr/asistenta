import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactTokensFromEnv, DEFAULT_COMPACTION } from '../src/core/history.js';

const DEF = DEFAULT_COMPACTION.triggerTokens;

describe('PA_COMPACT_TOKENS escrito como una persona', () => {
  it('vacío (tal cual viene en .env.example) deja el resumen encendido por defecto', () => {
    expect(compactTokensFromEnv('')).toBe(DEF);
    expect(compactTokensFromEnv('   ')).toBe(DEF);
    expect(compactTokensFromEnv(undefined)).toBe(DEF);
  });

  it('«100.000» con punto de miles no se lee como 100', () => {
    expect(compactTokensFromEnv('100.000')).toBe(100_000);
    expect(compactTokensFromEnv('100,000')).toBe(100_000);
    expect(compactTokensFromEnv('100 000')).toBe(100_000);
    expect(compactTokensFromEnv('100k')).toBe(100_000);
    expect(compactTokensFromEnv('80000')).toBe(80_000);
  });

  it('«0» sigue apagándolo a propósito; lo ilegible deja el por defecto', () => {
    expect(compactTokensFromEnv('0')).toBe(0);
    expect(compactTokensFromEnv('muchos')).toBe(DEF);
    expect(compactTokensFromEnv('-5')).toBe(DEF);
  });

  it('el agente lee PA_COMPACT_TOKENS con esta función', () => {
    const src = readFileSync('src/core/agent.ts', 'utf8');
    expect(src).not.toMatch(/Number\(process\.env\.PA_COMPACT_TOKENS/);
    expect(src).toContain('compactTokensFromEnv(process.env.PA_COMPACT_TOKENS)');
  });
});

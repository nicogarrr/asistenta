import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `pa --help` es lo primero que lee alguien nuevo: en castellano y al día. */
const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
const start = src.indexOf('const USAGE = `');
const usage = src.slice(start, src.indexOf('`;', start));
const lines = usage.split('\n').filter((l) => /^\s+pa /.test(l));
/** La explicación: lo que va tras la columna del comando (2+ espacios). */
const desc = (l: string) =>
  l
    .trim()
    .split(/\s{2,}/)
    .slice(1)
    .join(' ');

const ENGLISH =
  /\b(the|run the|talk|store|print|list secret|delete|check|probe|create|one|each|your|agent|secret|with|over|unattended|needs|environment|graceful)\b/i;

describe('pa --help en castellano', () => {
  it('cabecera y «Uso:» en castellano', () => {
    expect(usage).toContain('Asistenta');
    expect(usage).toContain('\nUso:\n');
    expect(usage).not.toMatch(/Usage:|personal agent/);
  });

  it('cada comando lleva su explicación y ninguna está en inglés', () => {
    expect(lines.length).toBeGreaterThan(30);
    const sinTexto = lines.filter((l) => !desc(l));
    expect(sinTexto).toEqual([]);
    const ingles = lines.filter((l) => ENGLISH.test(desc(l)));
    expect(ingles).toEqual([]);
  });

  it('pa stop ya no dice que es solo de Linux (en Windows también para)', () => {
    const stop = lines.find((l) => /^\s+pa stop\s/.test(l)) ?? '';
    expect(stop).not.toMatch(/^\s+pa stop\s+Linux:/);
    expect(stop).toMatch(/Windows/);
  });
});

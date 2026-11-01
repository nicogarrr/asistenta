import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `pa help` (USAGE en src/cli.ts) y el `switch (command)` de main() no pueden
 * separarse: cada subcomando que existe sale en la ayuda y la ayuda no anuncia
 * ninguno que no exista. Mismo espíritu que daemon-help-drift para /help.
 */
const src = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');

/** Subcomandos que no son para una persona, con el motivo. */
const NOT_IN_USAGE: Record<string, string> = {
  'autostart-notify': 'lo lanza la tarea programada de autostart, no se escribe a mano',
};
const HELP_ALIASES = new Set(['help', '--help', '-h', 'ayuda']);

function usageText(): string {
  const start = src.indexOf('const USAGE = `');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('`;', start);
  return src.slice(start, end);
}

function switchCases(): string[] {
  const start = src.indexOf('switch (command) {');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('process.stdout.write(USAGE);', start);
  expect(end).toBeGreaterThan(start);
  return [...src.slice(start, end).matchAll(/case '([^']+)':/g)].map((m) => m[1] ?? '');
}

function usageCommands(): Set<string> {
  return new Set([...usageText().matchAll(/(?:^|\|)\s*pa ([a-z][\w-]*)/gm)].map((m) => m[1] ?? ''));
}

describe('pa help no se separa de los subcomandos', () => {
  it('encuentra el switch y la ayuda', () => {
    expect(switchCases().length).toBeGreaterThan(10);
    expect(usageCommands().size).toBeGreaterThan(10);
  });

  it('cada subcomando de main() sale en pa help', () => {
    const usage = usageCommands();
    const missing = switchCases().filter(
      (c) => !HELP_ALIASES.has(c) && !(c in NOT_IN_USAGE) && !usage.has(c),
    );
    expect(missing).toEqual([]);
  });

  it('pa help no anuncia subcomandos que no existen', () => {
    const cases = new Set(switchCases());
    expect([...usageCommands()].filter((c) => !cases.has(c))).toEqual([]);
  });

  it('las excepciones existen de verdad y no salen en la ayuda', () => {
    const cases = new Set(switchCases());
    const usage = usageCommands();
    for (const name of Object.keys(NOT_IN_USAGE)) {
      expect(cases.has(name)).toBe(true);
      expect(usage.has(name)).toBe(false);
    }
  });
});

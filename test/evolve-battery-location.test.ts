import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BATTERY_FILE } from '../src/evolve/battery-gate.js';
import { checkPatch } from '../src/evolve/guard.js';
import { touchesForbidden } from '../src/evolve/score.js';

const diffOf = (file: string): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;

describe('la batería vive en evolve/ y el bucle no puede tocarla', () => {
  it('evolve/battery.json existe con sus 74 casos; selfimprove/battery.json ya no', () => {
    expect(BATTERY_FILE).toBe('evolve/battery.json');
    const file = join(process.cwd(), BATTERY_FILE);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).cases).toHaveLength(74);
    expect(existsSync(join(process.cwd(), 'selfimprove', 'battery.json'))).toBe(false);
  });

  it.each([
    'evolve/battery.json',
    'selfimprove/battery.json',
    'scripts/evolve-battery-case.mjs',
    'src/evolve/battery-case.ts',
    'src/evolve/battery-gate.ts',
    'src/evolve/battery-judge.ts',
  ])('el guard rechaza un parche que toca %s', (file) => {
    expect(checkPatch(diffOf(file)).length).toBeGreaterThan(0);
  });

  it('el evaluador también está en la lista de prohibidos de la puntuación', () => {
    expect(touchesForbidden(['scripts/evolve-battery-case.mjs'])).toHaveLength(1);
    expect(touchesForbidden(['evolve/battery.json'])).toHaveLength(1);
  });

  it('un cambio normal en src/ sigue permitido', () => {
    expect(checkPatch(diffOf('src/tools/memory.ts'))).toEqual([]);
  });
});

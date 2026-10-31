import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_SWITCHES, envSwitchesDoctorLine, envSwitchOn } from '../src/env-flags.js';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('PA_MEMORY_CONSOLIDATE escrito como una persona', () => {
  it('se enciende con 1, sí, true u on y se queda apagado con no o vacío', () => {
    for (const v of ['1', 'sí', 'true', 'On']) {
      expect(envSwitchOn('PA_MEMORY_CONSOLIDATE', env({ PA_MEMORY_CONSOLIDATE: v }))).toBe(true);
    }
    for (const v of ['0', 'no', '', 'quizá']) {
      expect(envSwitchOn('PA_MEMORY_CONSOLIDATE', env({ PA_MEMORY_CONSOLIDATE: v }))).toBe(false);
    }
    expect(envSwitchOn('PA_MEMORY_CONSOLIDATE', env({}))).toBe(false);
  });

  it('pa doctor avisa si no entiende el valor', () => {
    expect(envSwitchesDoctorLine(env({ PA_MEMORY_CONSOLIDATE: 'vale' }))).toContain(
      'PA_MEMORY_CONSOLIDATE «vale»',
    );
  });

  it('ningún interruptor de la lista se lee comparando con «1» o «0» a mano', () => {
    const raw = sources('src').flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return ENV_SWITCHES.filter(({ name }) =>
        new RegExp(`env\\.${name}\\s*[!=]==\\s*['"]`).test(text),
      ).map(({ name }) => `${file}: ${name}`);
    });
    expect(raw).toEqual([]);
  });
});

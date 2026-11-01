import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { measure, suiteUnfinished } from '../src/evolve/measure.js';

// La suite de tests de un candidato termina con salida 0 (todo verde) o 1 (hay fallos). Antes
// se ignoraba su código de salida: una suite que imprimía el resumen y luego reventaba, se
// quedaba colgada hasta el timeout o la mataban contaba igual como medida.

describe('suiteUnfinished', () => {
  it('acepta una suite que terminó, verde o con fallos', () => {
    expect(suiteUnfinished(0, 0)).toBeNull();
    expect(suiteUnfinished(1, 3)).toBeNull();
    expect(suiteUnfinished(1, 0)).toBeNull();
  });
  it('una suite que revienta, la matan o se pasa de tiempo no está medida', () => {
    expect(suiteUnfinished(null, 0)).toMatch(/sin código.*no medido/);
    expect(suiteUnfinished(137, 0)).toMatch(/salida 137.*no medido/);
    expect(suiteUnfinished('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 0)).toMatch(/no medido/);
    // Salida 0 con fallos en el resumen: el resumen no es de esta ejecución.
    expect(suiteUnfinished(0, 2)).toMatch(/no medido/);
  });
});

// measure() de verdad, con un `npx` falso en el PATH (sh: solo POSIX).
describe.skipIf(process.platform === 'win32')('measure con la suite', () => {
  const dirs: string[] = [];
  const oldPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = oldPath;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function setup(suiteExit: string): string {
    const bin = mkdtempSync(join(tmpdir(), 'evolve-npx-'));
    const cwd = mkdtempSync(join(tmpdir(), 'evolve-cwd-'));
    dirs.push(bin, cwd);
    const report = JSON.stringify({
      numTotalTestSuites: 1,
      testResults: [
        { name: '/x/test/a.test.ts', assertionResults: [{ fullName: 'a', status: 'passed' }] },
      ],
    });
    writeFileSync(join(cwd, 'report.json'), report);
    writeFileSync(
      join(bin, 'npx'),
      [
        '#!/bin/sh',
        'if [ "$1" = vitest ]; then',
        "  echo ' Test Files  1 passed (1)'; echo '      Tests  1 passed (1)'; cat report.json; echo",
        `  ${suiteExit}`,
        'fi',
        "echo 'PASA uno'; echo; echo 'FLUJO GENERICO OK'; exit 0",
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'npx'), 0o755);
    process.env.PATH = `${bin}${delimiter}${oldPath}`;
    return cwd;
  }
  it('una suite que imprime el resumen y luego revienta sale como no medida', async () => {
    const m = await measure({ cwd: setup('exit 134') });
    expect(m.error).toMatch(/suite de tests no terminó.*no medido/);
  });
  it('una suite que matan con una señal sale como no medida', async () => {
    const m = await measure({ cwd: setup('kill -9 $$') });
    expect(m.error).toMatch(/suite de tests no terminó.*no medido/);
  });
  it('una suite que termina sigue siendo una medida', async () => {
    const m = await measure({ cwd: setup('exit 0') });
    expect(m.error).toBeUndefined();
    expect(m.passed).toBe(1);
    expect(m.checks).toBe(1);
  });
});

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { measure, reportFromOutput } from '../src/evolve/measure.js';

// El informe por test se escribía en un fichero de la carpeta temporal compartida. Un proceso
// que el intento deja vivo (mismo usuario) puede buscar evolve-rep-* y cambiar el informe
// después de que vitest lo escriba: pasa a decir qué tests pasaron. Ahora el informe sale por
// la salida estándar de vitest, que solo lee measure(), y una segunda copia no se acepta.

const real = (name: string) =>
  JSON.stringify({
    numTotalTestSuites: 1,
    testResults: [
      { name: '/x/test/a.test.ts', assertionResults: [{ fullName: name, status: 'passed' }] },
    ],
  });

describe('reportFromOutput', () => {
  it('toma la única línea de informe de la salida', () => {
    expect(reportFromOutput(`a\n Tests  1 passed (1)\n${real('a')}\n`)).toBe(real('a'));
  });
  it('dos informes, uno pegado a otra línea o ninguno: no hay informe', () => {
    expect(reportFromOutput(`${real('b')}\n${real('a')}\n`)).toBeNull();
    expect(reportFromOutput(`x${real('a')}\n`)).toBeNull();
    expect(reportFromOutput(`{"numTotalTestSuites":1,"z":${real('a')}\n`)).toBeNull();
    expect(reportFromOutput('Tests  1 passed (1)\n')).toBeNull();
  });
});

// measure() de verdad, con un `npx` falso en el PATH (sh: solo POSIX).
describe.skipIf(process.platform === 'win32')('measure y un informe cambiado', () => {
  const dirs: string[] = [];
  const oldPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = oldPath;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function setup(extraStdout = ''): string {
    const bin = mkdtempSync(join(tmpdir(), 'evolve-npx-'));
    const cwd = mkdtempSync(join(tmpdir(), 'evolve-cwd-'));
    dirs.push(bin, cwd);
    writeFileSync(join(cwd, 'report.json'), real('a'));
    writeFileSync(join(cwd, 'forged.json'), real('forjado'));
    writeFileSync(
      join(bin, 'npx'),
      [
        '#!/bin/sh',
        'if [ "$1" = vitest ]; then',
        '  out=',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: es sintaxis de sh, no de JS.
        '  for a in "$@"; do case "$a" in --outputFile.json=*) out="${a#--outputFile.json=}";; esac; done',
        `  ${extraStdout}`,
        "  echo ' Test Files  1 passed (1)'; echo '      Tests  1 passed (1)'",
        '  if [ -n "$out" ]; then cp report.json "$out"; else cat report.json; echo; fi',
        // Lo que dejaría vivo el intento: cambia todo informe que encuentre en la carpeta temporal.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: es sintaxis de sh, no de JS.
        '  for f in "${TMPDIR:-/tmp}"/evolve-rep-*/*.json "$out"; do [ -f "$f" ] && cp forged.json "$f"; done',
        '  exit 0',
        'fi',
        "echo 'PASA uno'; echo; echo 'FLUJO GENERICO OK'; exit 0",
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'npx'), 0o755);
    process.env.PATH = `${bin}${delimiter}${oldPath}`;
    return cwd;
  }
  it('un informe cambiado en la carpeta temporal no cuenta', async () => {
    const m = await measure({ cwd: setup() });
    expect(m.error).toBeUndefined();
    expect(m.passingTests).toEqual(['test/a.test.ts::a']);
  });
  it('un test que imprime otro informe deja la medida sin comparar', async () => {
    const m = await measure({ cwd: setup('cat forged.json; echo') });
    expect(m.error).toMatch(/no comparable/);
    expect(m.passingTests).toBeUndefined();
  });
});

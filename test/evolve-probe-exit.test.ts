import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { measure, probeUnfinished } from '../src/evolve/measure.js';

// La sonda de extremo a extremo (evolve/probe-generic-flow.ts) termina con «FLUJO GENERICO OK»
// o «N PASO(S) FALLARON». Antes se ignoraba su código de salida: una sonda que imprimía unos
// PASA y luego reventaba contaba como medida, y los pasos que nunca llegó a hacer no existían.

describe('probeUnfinished', () => {
  it('acepta una sonda que terminó, bien o con pasos fallidos', () => {
    expect(probeUnfinished('PASA a\n\nFLUJO GENERICO OK\n', 0)).toBeNull();
    expect(probeUnfinished('PASA a\nFALLA b — x\n\n1 PASO(S) FALLARON\r\n', 1)).toBeNull();
  });
  it('una sonda que revienta, la matan o para antes del final no está medida', () => {
    expect(probeUnfinished('PASA a\nTypeError: boom\n', 1)).toMatch(/no medido/);
    expect(probeUnfinished('PASA a\n', null)).toMatch(/sin código/);
    expect(probeUnfinished('PASA a\n', 0)).toMatch(/salida 0/);
    expect(probeUnfinished('PASA a\nFLUJO GENERICO OK\n', 'ETIMEDOUT')).toMatch(/no medido/);
    // «OK» impreso por la sonda pero salida 1: algo falló después del resumen.
    expect(probeUnfinished('FLUJO GENERICO OK\n', 1)).toMatch(/no medido/);
  });
});

// measure() de verdad, con un `npx` falso en el PATH (sh: solo POSIX).
describe.skipIf(process.platform === 'win32')('measure con la sonda', () => {
  const dirs: string[] = [];
  const oldPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = oldPath;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function setup(probeOut: string, probeCode: number): string {
    const bin = mkdtempSync(join(tmpdir(), 'evolve-npx-'));
    const cwd = mkdtempSync(join(tmpdir(), 'evolve-cwd-'));
    dirs.push(bin, cwd);
    const report = JSON.stringify({
      testResults: [
        { name: '/x/test/a.test.ts', assertionResults: [{ fullName: 'a', status: 'passed' }] },
      ],
    });
    writeFileSync(join(cwd, 'report.json'), report);
    writeFileSync(join(cwd, 'probe.out'), probeOut);
    writeFileSync(
      join(bin, 'npx'),
      [
        '#!/bin/sh',
        'if [ "$1" = vitest ]; then',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: es sintaxis de sh, no de JS.
        '  for a in "$@"; do case "$a" in --outputFile.json=*) cp report.json "${a#--outputFile.json=}";; esac; done',
        "  echo ' Test Files  1 passed (1)'; echo '      Tests  1 passed (1)'; exit 0",
        'fi',
        `cat probe.out; exit ${probeCode}`,
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'npx'), 0o755);
    process.env.PATH = `${bin}${delimiter}${oldPath}`;
    return cwd;
  }
  it('una sonda que revienta a mitad sale como no medida', async () => {
    const m = await measure({ cwd: setup('PASA uno\nError: boom\n', 3) });
    expect(m.error).toMatch(/no terminó.*no medido/);
  });
  it('una sonda que termina sigue siendo una medida', async () => {
    const ok = await measure({ cwd: setup('PASA uno\n\nFLUJO GENERICO OK\n', 0) });
    expect(ok.error).toBeUndefined();
    expect(ok.checks).toBe(1);
    const bad = await measure({ cwd: setup('PASA uno\nFALLA dos — x\n\n1 PASO(S) FALLARON\n', 1) });
    expect(bad.error).toBeUndefined();
    expect(bad.checksFailed).toBe(1);
  });
});

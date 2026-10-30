// FIRST import, always: factory-test-env assigns PA_STATE_DIR before store.ts
// (via paths.ts) snapshots it; imported later, the store writes elsewhere.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que store.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as store from '../src/factory/store.js';
import type { FactoryToolMeta } from '../src/factory/types.js';

function meta(id: string): FactoryToolMeta {
  return {
    id,
    name: 'Eco',
    description: 'Devuelve el texto',
    whenToUse: 'cuando pida eco',
    version: 1,
    status: 'built',
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    codeSha256: '',
    testedSha256: null,
    lastTestAt: null,
    lastTestOk: false,
    contract: null,
  };
}

const CODE = 'export default { run: async () => "ok" };\n';

describe('factory store: escritura con nombres temporales únicos', () => {
  it('no pisa ni se lleva el temporal de otro escritor que está guardando a la vez', () => {
    const dir = join(FACTORY_TEST_STATE_DIR, 'factory', 'tmp-tool');
    store.writeFactoryTool(meta('tmp-tool'), CODE, '');
    // Otro proceso (daemon o `pa`) está a mitad de guardar con el nombre clásico.
    const otherJs = join(dir, '.tool.js.tmp');
    const otherMd = join(dir, '.TOOL.md.tmp');
    writeFileSync(otherJs, 'export default "OTRO";\n');
    writeFileSync(otherMd, '---\nid: otro\n---\n');
    store.writeFactoryTool(meta('tmp-tool'), CODE, 'segunda');
    expect(readFileSync(otherJs, 'utf8')).toBe('export default "OTRO";\n');
    expect(readFileSync(otherMd, 'utf8')).toBe('---\nid: otro\n---\n');
    expect(readFileSync(join(dir, 'tool.js'), 'utf8')).toBe(CODE);
    expect(store.readFactoryTool('tmp-tool')?.notes).toBe('segunda');
  });

  it('no deja temporales propios tras guardar', () => {
    const dir = join(FACTORY_TEST_STATE_DIR, 'factory', 'tmp-clean');
    store.writeFactoryTool(meta('tmp-clean'), CODE, '');
    store.writeFactoryTool(meta('tmp-clean'), CODE, 'otra');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(join(dir, 'TOOL.md'))).toBe(true);
  });
});

describe('factory store: version', () => {
  function withVersion(id: string, v: string): void {
    store.writeFactoryTool(meta(id), CODE, '');
    const md = join(FACTORY_TEST_STATE_DIR, 'factory', id, 'TOOL.md');
    writeFileSync(md, readFileSync(md, 'utf8').replace(/^version: .*$/m, `version: ${v}`));
  }

  it('una versión que no es un número es TOOL.md corrupto, nunca NaN', () => {
    withVersion('ver-abc', 'abc');
    expect(() => store.readFactoryTool('ver-abc')).toThrow(/corrupto.*version/);
    expect(store.listFactoryTools().map((m) => m.id)).not.toContain('ver-abc');
  });

  it('rechaza también vacía, cero, negativa y decimal', () => {
    for (const [i, v] of ['', '0', '-2', '1.5', 'NaN'].entries()) {
      withVersion(`ver-bad${i}`, v);
      expect(() => store.readFactoryTool(`ver-bad${i}`)).toThrow(/corrupto/);
    }
  });

  it('una versión válida se lee como número', () => {
    withVersion('ver-ok', '7');
    expect(store.readFactoryTool('ver-ok')?.meta.version).toBe(7);
  });
});

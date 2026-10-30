// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que se cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertFactoryId,
  factoryDir,
  listFactoryTools,
  readFactoryTool,
  sha256,
  writeFactoryMeta,
  writeFactoryTestLog,
  writeFactoryTool,
} from '../src/factory/store.js';
import type { FactoryToolMeta } from '../src/factory/types.js';

function meta(id: string, extra: Partial<FactoryToolMeta> = {}): FactoryToolMeta {
  const code = 'export default () => 1;';
  return {
    id,
    name: 'Euro a pesetas',
    description: 'Convierte "euros"\ny más',
    whenToUse: 'cuando pida pesetas',
    version: 2,
    status: 'tested',
    createdAt: '2026-10-30T10:00:00Z',
    updatedAt: '2026-10-30T11:00:00Z',
    codeSha256: sha256(code),
    testedSha256: sha256(code),
    lastTestAt: '2026-10-30T11:00:00Z',
    lastTestOk: true,
    contract: { name: id, description: 'd', parameters: { type: 'object' } },
    ...extra,
  };
}

describe('factory/store', () => {
  it('ida y vuelta: lo que se escribe es lo que se lee', () => {
    expect(factoryDir('ida-vuelta').startsWith(FACTORY_TEST_STATE_DIR)).toBe(true);
    writeFactoryTool(meta('ida-vuelta'), 'export default () => 1;', 'nota 1');
    const t = readFactoryTool('ida-vuelta');
    expect(t?.meta).toEqual(meta('ida-vuelta'));
    expect(t?.code).toBe('export default () => 1;');
    expect(t?.notes).toBe('nota 1');
    writeFactoryMeta({ ...meta('ida-vuelta'), status: 'installed' }, '');
    expect(readFactoryTool('ida-vuelta')?.meta.status).toBe('installed');
    expect(readFactoryTool('ida-vuelta')?.notes).toBe('(sin notas)');
    expect(() => writeFactoryMeta(meta('no-existe'), '')).toThrow(/desconocida/);
    expect(readFactoryTool('no-existe')).toBeNull();
    writeFactoryTestLog('ida-vuelta', 'ok');
    expect(readFileSync(join(factoryDir('ida-vuelta'), 'test.log'), 'utf8')).toBe('ok');
  });

  it('ids que no son un slug no llegan al disco', () => {
    for (const bad of ['../fuera', 'Mayus', 'a/b', '', 'x'.repeat(200)])
      expect(() => assertFactoryId(bad)).toThrow(/invalid factory tool id/);
    expect(() => readFactoryTool('../fuera')).toThrow();
  });

  it('un TOOL.md guardado con saltos de línea de Windows (CRLF) se sigue leyendo', () => {
    writeFactoryTool(meta('crlf-tool'), 'export default () => 1;', 'nota');
    const md = join(factoryDir('crlf-tool'), 'TOOL.md');
    writeFileSync(md, readFileSync(md, 'utf8').replace(/\n/g, '\r\n'));
    expect(readFactoryTool('crlf-tool')?.meta).toEqual(meta('crlf-tool'));
    expect(readFactoryTool('crlf-tool')?.notes).toBe('nota');
    expect(listFactoryTools().map((m) => m.id)).toContain('crlf-tool');
  });

  it('«## Notes» dentro de la descripción no se come las notas', () => {
    writeFactoryTool(
      meta('notas-tool', { description: 'ver ## Notes abajo' }),
      'x',
      'la nota real',
    );
    const t = readFactoryTool('notas-tool');
    expect(t?.notes).toBe('la nota real');
    expect(t?.meta.description).toBe('ver ## Notes abajo');
  });

  it('más estricto: un TOOL.md cuyo id no es el de su carpeta es corrupto', () => {
    writeFactoryTool(meta('copia-tool'), 'x', '');
    const md = join(factoryDir('copia-tool'), 'TOOL.md');
    writeFileSync(md, readFileSync(md, 'utf8').replace('id: copia-tool', 'id: ida-vuelta'));
    expect(() => readFactoryTool('copia-tool')).toThrow(/corrupto/);
    expect(listFactoryTools().map((m) => m.id)).not.toContain('copia-tool');
    expect(listFactoryTools().filter((m) => m.id === 'ida-vuelta')).toHaveLength(1);
  });

  it('la lista se salta lo corrupto, carpetas con nombre raro y status desconocido', () => {
    writeFactoryTool(meta('estado-raro'), 'x', '');
    const md = join(factoryDir('estado-raro'), 'TOOL.md');
    writeFileSync(md, readFileSync(md, 'utf8').replace('status: tested', 'status: hacked'));
    expect(() => readFactoryTool('estado-raro')).toThrow(/status/);
    mkdirSync(join(factoryDir('sin-frontmatter')), { recursive: true });
    writeFileSync(join(factoryDir('sin-frontmatter'), 'TOOL.md'), 'hola');
    writeFileSync(join(factoryDir('sin-frontmatter'), 'tool.js'), 'x');
    expect(() => readFactoryTool('sin-frontmatter')).toThrow(/frontmatter/);
    mkdirSync(join(FACTORY_TEST_STATE_DIR, 'factory', 'Carpeta Rara'), { recursive: true });
    const ids = listFactoryTools().map((m) => m.id);
    expect(ids).not.toContain('estado-raro');
    expect(ids).not.toContain('sin-frontmatter');
    expect(ids).toEqual([...ids].sort());
  });
});

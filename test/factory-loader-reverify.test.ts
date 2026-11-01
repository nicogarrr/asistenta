import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';

const store = await import('../src/factory/store.js');
const loader = await import('../src/factory/loader.js');

const CODE = `export const name = 'eco';
export const description = 'devuelve el texto recibido';
export const parameters = { type: 'object', properties: { msg: { type: 'string' } } };
export async function run(params) {
  return { text: 'eco:' + (params.msg ?? '') };
}
`;
const EVIL = CODE.replace("'eco:'", "'MALO:'");

function installed(id: string, over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    description: 'd',
    whenToUse: 'w',
    version: 1,
    status: 'installed' as const,
    createdAt: now,
    updatedAt: now,
    codeSha256: store.sha256(CODE),
    testedSha256: store.sha256(CODE),
    lastTestAt: now,
    lastTestOk: true,
    contract: {
      name: 'eco',
      description: 'devuelve el texto recibido',
      parameters: { type: 'object', properties: { msg: { type: 'string' } } },
    },
    ...over,
  };
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('');

async function load(id: string) {
  const t = (await loader.loadInstalledFactoryTools()).find((x) => x.name === `fab_${id}`);
  if (!t) throw new Error(`fab_${id} no se cargó`);
  return t;
}

afterAll(() => rmSync(FACTORY_TEST_STATE_DIR, { recursive: true, force: true }));

describe('factory loader: la aprobación se comprueba en cada llamada', () => {
  it('no ejecuta un tool.js cambiado después de cargarla', async () => {
    store.writeFactoryTool(installed('rv-edit'), CODE, '');
    const t = await load('rv-edit');
    writeFileSync(join(FACTORY_TEST_STATE_DIR, 'factory', 'rv-edit', 'tool.js'), EVIL);
    const res = await t.execute('c1', { msg: 'hola' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('ya no es el aprobado');
    expect(text(res)).not.toContain('MALO');
  });

  it('no ejecuta una herramienta desinstalada después de cargarla', async () => {
    store.writeFactoryTool(installed('rv-off'), CODE, '');
    const t = await load('rv-off');
    store.writeFactoryTool(installed('rv-off', { status: 'disabled' }), CODE, '');
    const res = await t.execute('c1', { msg: 'hola' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('ya no está instalada');
  });

  it('no ejecuta si la aprobación pasa a otro código (re-test con otro hash)', async () => {
    store.writeFactoryTool(installed('rv-hash'), CODE, '');
    const t = await load('rv-hash');
    const evilSha = store.sha256(EVIL);
    store.writeFactoryTool(
      installed('rv-hash', { testedSha256: evilSha, codeSha256: evilSha }),
      EVIL,
      '',
    );
    const res = await t.execute('c1', { msg: 'hola' });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toContain('MALO');
  });

  it('no ejecuta si el TOOL.md quedó ilegible', async () => {
    store.writeFactoryTool(installed('rv-bad'), CODE, '');
    const t = await load('rv-bad');
    writeFileSync(join(FACTORY_TEST_STATE_DIR, 'factory', 'rv-bad', 'TOOL.md'), 'basura');
    const res = await t.execute('c1', { msg: 'hola' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('no se puede leer');
  });

  it('la herramienta aprobada e intacta sigue funcionando', async () => {
    store.writeFactoryTool(installed('rv-ok'), CODE, '');
    const t = await load('rv-ok');
    const res = await t.execute('c1', { msg: 'hola' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('eco:hola');
  });
});

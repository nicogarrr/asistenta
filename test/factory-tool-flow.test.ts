import './factory-test-env.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const store = await import('../src/factory/store.js');
const fab = await import('../src/tools/factory.js');

const GOOD = `export const name = 'eco';
export const description = 'devuelve el texto recibido';
export const parameters = { type: 'object', properties: { msg: { type: 'string' } } };
export async function run(params) { return 'eco:' + (params.msg ?? ''); }
`;
const BAD = `export const name = 'mal';
export const description = 'lanza';
export const parameters = { type: 'object' };
export async function run() { throw new Error('boom'); }
`;

function txt(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

function setup() {
  let changes = 0;
  const tool = fab.createFactoryTool({ onChange: () => changes++ });
  const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
  const build = (id: string, code = GOOD) =>
    run({
      action: 'build',
      id,
      name: id,
      description: 'd',
      whenToUse: 'w',
      parameters: { type: 'object' },
      code,
    });
  return { run, build, changes: () => changes };
}

async function installed(id: string) {
  const s = setup();
  await s.build(id);
  await s.run({ action: 'test', id, sampleParams: { msg: 'x' } });
  await s.run({ action: 'install', id });
  expect(store.readFactoryTool(id)?.meta.status).toBe('installed');
  return s;
}

describe('fabrica: re-test de una herramienta instalada', () => {
  it('un test que pasa sobre el mismo artefacto NO la desinstala', async () => {
    const s = await installed('re-test-ok');
    const r = await s.run({ action: 'test', id: 're-test-ok', sampleParams: { msg: 'y' } });
    expect(txt(r)).toContain('TEST OK');
    expect(store.readFactoryTool('re-test-ok')?.meta.status).toBe('installed');
    expect(store.readFactoryTool('re-test-ok')?.meta.testedSha256).toBe(
      store.sha256(store.readFactoryTool('re-test-ok')?.code ?? ''),
    );
  });

  it('si el codigo en disco cambio, el test que pasa retira la instalacion (pide aprobacion otra vez)', async () => {
    const s = await installed('re-test-tamper');
    const before = s.changes();
    writeFileSync(
      join(store.factoryDir('re-test-tamper'), 'tool.js'),
      `${GOOD}\n// cambiado a mano\n`,
    );
    await s.run({ action: 'test', id: 're-test-tamper' });
    const meta = store.readFactoryTool('re-test-tamper')?.meta;
    expect(meta?.status).toBe('tested');
    expect(s.changes()).toBe(before + 1);
    // y volver a instalar pasa por install (aprobacion humana), no queda bendecida sola
    const r = await s.run({ action: 'install', id: 're-test-tamper' });
    expect(txt(r)).toContain('Instalada');
  });

  it('un test fallido de una instalada la deja instalada con el hash aprobado intacto', async () => {
    const s = await installed('re-test-fail');
    const hash = store.readFactoryTool('re-test-fail')?.meta.testedSha256;
    writeFileSync(join(store.factoryDir('re-test-fail'), 'tool.js'), BAD);
    const r = await s.run({ action: 'test', id: 're-test-fail' });
    expect(txt(r)).toContain('TEST FALLIDO');
    const meta = store.readFactoryTool('re-test-fail')?.meta;
    expect(meta?.status).toBe('installed');
    expect(meta?.testedSha256).toBe(hash);
    expect(meta?.lastTestOk).toBe(false);
  });
});

describe('fabrica: ramas sin cubrir', () => {
  it('list vacia / con herramientas, read y read inexistente', async () => {
    const s = setup();
    const empty = txt(await s.run({ action: 'list' }));
    expect(empty.includes('Fabrica vacia') || empty.includes('[')).toBe(true);
    await s.build('ramas-read');
    expect(txt(await s.run({ action: 'list' }))).toContain('ramas-read [built] v1');
    expect(txt(await s.run({ action: 'read', id: 'ramas-read' }))).toContain('--- tool.js ---');
    await expect(s.run({ action: 'read', id: 'no-existe' })).rejects.toThrow(/no existe/);
    await expect(s.run({ action: 'read' })).rejects.toThrow(/falta el campo "id"/);
  });

  it('build: campos obligatorios, id derivado, id invalido, tope de bytes y rebuild sube version', async () => {
    const s = setup();
    await expect(
      s.run({
        action: 'build',
        name: 'x',
        description: '',
        whenToUse: 'w',
        parameters: {},
        code: GOOD,
      }),
    ).rejects.toThrow(/falta el campo "description"/);
    const r = await s.run({
      action: 'build',
      name: 'Ñandú Rápido!',
      description: 'd',
      whenToUse: 'w',
      parameters: {},
      code: GOOD,
    });
    expect(txt(r)).toContain('nandu-rapido');
    await expect(s.build('Mal Id')).rejects.toThrow(/id invalido/);
    await expect(s.build('enorme', 'x'.repeat(70_000))).rejects.toThrow(/maximo/);
    const again = await s.build('nandu-rapido');
    expect(txt(again)).toContain('v2');
    expect(txt(again)).not.toContain('Luego "install"');
  });

  it('build sobre una instalada se rechaza (hay que usar improve)', async () => {
    const s = await installed('ramas-inst');
    await expect(s.build('ramas-inst')).rejects.toThrow(/improve/);
    expect(txt(await s.run({ action: 'install', id: 'ramas-inst' }))).toContain(
      'ya estaba instalada',
    );
  });

  it('test fallido de una construida queda en built y no se puede instalar', async () => {
    const s = setup();
    await s.build('ramas-bad', BAD);
    expect(txt(await s.run({ action: 'test', id: 'ramas-bad' }))).toContain('TEST FALLIDO');
    expect(store.readFactoryTool('ramas-bad')?.meta.status).toBe('built');
    await expect(s.run({ action: 'install', id: 'ramas-bad' })).rejects.toThrow(/test/);
    await expect(s.run({ action: 'test', id: 'no-existe' })).rejects.toThrow(/no existe/);
  });

  it('uninstall -> reinstall: con test vigente vale; con codigo cambiado exige test', async () => {
    const s = await installed('ramas-un');
    const n = s.changes();
    expect(txt(await s.run({ action: 'uninstall', id: 'ramas-un' }))).toContain('Retirada');
    expect(store.readFactoryTool('ramas-un')?.meta.status).toBe('disabled');
    expect(s.changes()).toBe(n + 1);
    expect(txt(await s.run({ action: 'install', id: 'ramas-un' }))).toContain('Instalada');
    await s.run({ action: 'uninstall', id: 'ramas-un' });
    writeFileSync(join(store.factoryDir('ramas-un'), 'tool.js'), `${GOOD}\n// otro\n`);
    await expect(s.run({ action: 'install', id: 'ramas-un' })).rejects.toThrow(/disabled/);
    await expect(s.run({ action: 'uninstall', id: 'no-existe' })).rejects.toThrow(/no existe/);
  });

  it('improve: inexistente, tope de bytes y nota por defecto', async () => {
    const s = setup();
    await expect(s.run({ action: 'improve', id: 'no-existe', code: GOOD })).rejects.toThrow(
      /no existe/,
    );
    await s.build('ramas-imp');
    await expect(
      s.run({ action: 'improve', id: 'ramas-imp', code: 'x'.repeat(70_000) }),
    ).rejects.toThrow(/maximo/);
    await s.run({ action: 'improve', id: 'ramas-imp', code: `${GOOD}//2\n` });
    expect(store.readFactoryTool('ramas-imp')?.notes).toContain('[v2] sin nota');
  });

  it('accion desconocida', async () => {
    const s = setup();
    await expect(s.run({ action: 'borrar' })).rejects.toThrow(/accion desconocida/);
  });
});

describe('fabrica: una herramienta retirada', () => {
  it('un test fallido la deja «disabled», no la rebaja a «built»', async () => {
    const s = await installed('retirada-falla');
    await s.run({ action: 'uninstall', id: 'retirada-falla' });
    const dir = join(store.factoryRoot(), 'retirada-falla');
    writeFileSync(join(dir, 'tool.js'), BAD);
    const r = await s.run({ action: 'test', id: 'retirada-falla' });
    expect(txt(r)).toContain('TEST FALLIDO');
    expect(store.readFactoryTool('retirada-falla')?.meta.status).toBe('disabled');
    await expect(s.run({ action: 'install', id: 'retirada-falla' })).rejects.toThrow(/test/);
  });
});

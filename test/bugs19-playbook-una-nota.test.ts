// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaybookStore } from '../src/gestor/playbooks.js';
import { GestorStore } from '../src/gestor/store.js';
import { createGestionTool } from '../src/tools/gestion.js';
import { clearVaultCache, vaultSet } from '../src/vault.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'bugs19-playbook-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  clearVaultCache();
  delete process.env.PA_VAULT_BACKEND;
  delete process.env.PA_SECRETS_FILE;
});

async function save(args: Record<string, unknown>): Promise<string> {
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(tmp(), 'secrets.json');
  await vaultSet('site:otro.es:password', 'valor-sintetico-bugs19');
  const tool = createGestionTool({
    gestor: new GestorStore({ db: new DatabaseSync(':memory:') }),
    scopeOf: () => 'scope',
    playbooks: new PlaybookStore({ dir: tmp() }),
    routines: { getRoutine: () => null },
  });
  const res = await tool.execute('c', { action: 'playbook_guardar', ...args } as never);
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

// asis-bugs-19: al guardar un playbook con una sola nota decía «(1 notas)».
describe('gestión: el playbook guardado cuenta sus notas en singular', () => {
  it('una nota → «(1 nota)»', async () => {
    const text = await save({
      dominio: 'seg-social.es',
      quirks: ['si sale captcha, para y avisa'],
    });
    expect(text).toContain('Playbook de seg-social.es guardado (1 nota).');
  });

  it('varias siguen en plural', async () => {
    const text = await save({
      dominio: 'seg-social.es',
      selectores: ['botón Entrar: #entrar'],
      quirks: ['si sale captcha, para y avisa'],
    });
    expect(text).toContain('guardado (2 notas).');
  });
});

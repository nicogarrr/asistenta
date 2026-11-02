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
import { DocMemory } from '../src/memory/docs.js';
import { playbookSavedText } from '../src/teach-demo-web.js';
import { createDocsTool } from '../src/tools/docs.js';
import { createGestionTool } from '../src/tools/gestion.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'bugs19-singular-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});
const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n');

// asis-bugs-19: «1 fragmentos», «1 pasos registrados», «1 selectores y 1 campos secretos».
describe('documentos, gestiones y /learn web: con uno, en singular', () => {
  it('la lista de documentos con un documento de un solo fragmento', async () => {
    const dir = tmp();
    const mem = new DocMemory({ dbPath: join(dir, 'd.sqlite'), directory: join(dir, 'm') });
    try {
      await mem.index(
        'telegram:1#main',
        { fileId: 'x1', name: 'nota.txt', mimeType: 'text/plain' },
        Buffer.from('una nota corta'),
      );
      const tool = createDocsTool(mem, () => 'telegram:1#main');
      const text = textOf((await tool.execute('t', { action: 'list' } as never)) as never);
      expect(text).toContain('1 fragmento)');
      expect(text).not.toContain('1 fragmentos');
    } finally {
      mem.close();
    }
  });

  it('una gestión de un solo paso al completarla', async () => {
    const gestor = new GestorStore({ db: new DatabaseSync(':memory:') });
    const tool = createGestionTool({
      gestor,
      scopeOf: () => 'scope',
      playbooks: new PlaybookStore({ dir: tmp() }),
      routines: { getRoutine: () => null },
    });
    const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
    await run({
      action: 'preparar',
      titulo: 'Vida laboral',
      encargo: 'descárgame la vida laboral',
      pasos: [{ texto: 'Entrar y descargar el PDF', efecto: 'lee' }],
    });
    const id = gestor.list('scope')[0]?.id ?? '';
    await run({ action: 'ejecutar', id });
    await run({ action: 'paso', paso: 1, nota: 'descargado' });
    const done = textOf(await run({ action: 'completar' }));
    expect(done).toContain('terminada. 1 paso registrado.');
  });

  it('/learn web: un selector y un campo secreto', () => {
    expect(playbookSavedText('tienda.es', 1, 1)).toBe(
      'Playbook de tienda.es guardado: 1 selector y 1 campo secreto (solo el nombre de la clave). Los valores que escribiste no se guardan.',
    );
    expect(playbookSavedText('tienda.es', 2, 0)).toContain('2 selectores y 0 campos secretos');
  });
});

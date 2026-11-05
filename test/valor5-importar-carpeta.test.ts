/**
 * «Guarda mi carpeta de apuntes en mis documentos» (hueco #12, segunda mitad): antes había
 * que reenviar los ficheros uno a uno por Telegram. Ahora `documents` con
 * action=import_folder guarda los documentos que sabe leer de una carpeta del PC (PDF,
 * Word, Excel, texto…), sin ocultos ni enlaces, y volver a importarla los actualiza. Solo en
 * el chat privado del dueño, y la Gate pregunta cada vez (lee fuera de la carpeta de trabajo).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocMemory } from '../src/memory/docs.js';
import { Gate } from '../src/permissions.js';
import { createDocsTool, listFolder } from '../src/tools/docs.js';

const dirs: string[] = [];
const mems: DocMemory[] = [];
afterEach(() => {
  for (const m of mems.splice(0)) m.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'v5-carpeta-'));
  dirs.push(d);
  return d;
};
const mem = (): DocMemory => {
  const d = tmp();
  const m = new DocMemory({ dbPath: join(d, 'd.sqlite'), directory: join(d, 'txt') });
  mems.push(m);
  return m;
};
const textOf = (r: unknown): string =>
  (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n');
const A = 'telegram:main:111#main';

function apuntes(): string {
  const root = tmp();
  writeFileSync(
    join(root, 'tema1.txt'),
    'La mitosis tiene cuatro fases: profase, metafase, anafase y telofase.',
  );
  mkdirSync(join(root, 'Bioquímica'));
  writeFileSync(
    join(root, 'Bioquímica', 'enzimas.md'),
    '# Enzimas\n\nLa amilasa rompe el almidón.',
  );
  writeFileSync(join(root, 'foto.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  writeFileSync(join(root, '.env'), 'CLAVE=secreta');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config.txt'), 'nada');
  writeFileSync(join(root, 'vacio.txt'), '');
  try {
    symlinkSync(join(root, 'tema1.txt'), join(root, 'enlace.txt'));
  } catch {
    // Sin permisos para enlaces (Windows sin modo desarrollador): da igual para el resto.
  }
  return root;
}

describe('documents: importar una carpeta del PC', () => {
  it('guarda lo que sabe leer, sin ocultos ni enlaces, y luego se encuentra', async () => {
    const m = mem();
    const root = apuntes();
    const tool = createDocsTool(m, () => A, { folderAllowed: () => true });
    const r = textOf(
      await tool.execute(
        '1',
        { action: 'import_folder', path: root },
        undefined as never,
        undefined as never,
      ),
    );
    expect(r).toContain('Guardados 2 documentos');
    expect(r).toContain('2 de otro tipo o de más de 20 MB');
    const list = textOf(
      await tool.execute('2', { action: 'list' }, undefined as never, undefined as never),
    );
    expect(list).toContain('tema1.txt');
    expect(list).toContain(join('Bioquímica', 'enzimas.md'));
    expect(list).not.toContain('.env');
    expect(list).not.toContain('enlace');
    expect(
      textOf(
        await tool.execute(
          '3',
          { action: 'search', query: 'amilasa' },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toContain('enzimas.md');
  });

  it('importar otra vez actualiza, no duplica', async () => {
    const m = mem();
    const root = apuntes();
    const tool = createDocsTool(m, () => A, { folderAllowed: () => true });
    await tool.execute(
      '1',
      { action: 'import_folder', path: root },
      undefined as never,
      undefined as never,
    );
    writeFileSync(join(root, 'tema1.txt'), 'La meiosis produce cuatro células hijas.');
    await tool.execute(
      '2',
      { action: 'import_folder', path: root },
      undefined as never,
      undefined as never,
    );
    expect(m.listIn([A])).toHaveLength(2);
    expect(
      textOf(
        await tool.execute(
          '3',
          { action: 'search', query: 'meiosis' },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toContain('tema1.txt');
    expect(
      textOf(
        await tool.execute(
          '4',
          { action: 'search', query: 'telofase' },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toMatch(/No he encontrado/);
  });

  it('fuera del chat del dueño o con una carpeta que no existe no guarda nada', async () => {
    const m = mem();
    const root = apuntes();
    const otro = createDocsTool(m, () => A, { folderAllowed: () => false });
    expect(
      textOf(
        await otro.execute(
          '1',
          { action: 'import_folder', path: root },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toMatch(/solo se puede desde el chat privado del dueño/);
    const sinDeps = createDocsTool(m, () => A);
    expect(
      textOf(
        await sinDeps.execute(
          '2',
          { action: 'import_folder', path: root },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toMatch(/dueño/);
    const tool = createDocsTool(m, () => A, { folderAllowed: () => true });
    expect(
      textOf(
        await tool.execute(
          '3',
          { action: 'import_folder', path: join(root, 'no-existe') },
          undefined as never,
          undefined as never,
        ),
      ),
    ).toMatch(/No encuentro la carpeta/);
    expect(m.listIn([A])).toHaveLength(0);
  });

  it('tope de ficheros', async () => {
    const root = tmp();
    for (let i = 0; i < 205; i++)
      writeFileSync(join(root, `n${String(i).padStart(3, '0')}.txt`), `nota ${i}`);
    const r = await listFolder(root);
    expect(r.files).toHaveLength(200);
    expect(r.more).toBe(true);
  });

  it('la Gate pregunta para importar una carpeta; buscar sigue siendo lectura', () => {
    const gate = new Gate();
    expect(
      gate.classifyEffect({
        tool: 'documents',
        args: { action: 'import_folder', path: 'C:\\Apuntes' },
        actor: 'test',
      }),
    ).toBeNull();
    expect(
      gate.classifyEffect({
        tool: 'documents',
        args: { action: 'search', query: 'x' },
        actor: 'test',
      }),
    ).toBe('lee');
    expect(
      gate.classifyEffect({
        tool: 'documents',
        args: { action: 'save_url', url: 'https://a.es' },
        actor: 'test',
      }),
    ).toBe('lee');
  });
});

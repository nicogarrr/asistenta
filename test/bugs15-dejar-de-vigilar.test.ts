import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PageWatchStore, watchNamed } from '../src/watch/pages.js';

function store() {
  const db = new DatabaseSync(':memory:');
  const w = new PageWatchStore(db, () => 1_000);
  const a = w.add('chat', 'https://tienda.example/ps5', 'PS5');
  const b = w.add('chat', 'https://tienda.example/tele', 'Tele 55');
  db.prepare('UPDATE page_watches SET id = ? WHERE id = ?').run('a1b2c3d4', a.id);
  db.prepare('UPDATE page_watches SET id = ? WHERE id = ?').run('a1ff0000', b.id);
  return w;
}

describe('/dejar_de_vigilar: nunca quita una vigilancia que no se nombró', () => {
  it('un trozo de código que vale para dos no quita ninguna (antes quitaba la primera)', () => {
    const w = store();
    expect(w.remove('chat', 'a1')).toBe(false);
    expect(w.list('chat')).toHaveLength(2);
  });

  it('el código entero o un trozo que solo vale para una sí', () => {
    const w = store();
    expect(w.remove('chat', 'a1f')).toBe(true);
    expect(w.list('chat').map((x) => x.label)).toEqual(['PS5']);
    expect(w.remove('chat', 'a1b2c3d4')).toBe(true);
    expect(w.list('chat')).toHaveLength(0);
  });

  it('«/dejar_de_vigilar tele» o «la de la PS5»: por el nombre, como la respuesta a la pregunta', () => {
    const list = store().list('chat');
    expect(watchNamed(list, 'tele')?.label).toBe('Tele 55');
    expect(watchNamed(list, 'la de la PS5')?.label).toBe('PS5');
    expect(watchNamed(list, 'A1B2C3D4')?.label).toBe('PS5');
    expect(watchNamed(list, 'a1f')?.label).toBe('Tele 55');
    expect(watchNamed(list, 'a1')).toBeNull();
    expect(watchNamed(list, 'tienda')).toBeNull();
  });

  it('el comando usa esa búsqueda', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    const body = cli.slice(
      cli.indexOf('const cmdDejarDeVigilar'),
      cli.indexOf('const checkPageWatch'),
    );
    expect(body).toContain('watchNamed(list, id)');
    const precio = cli.slice(cli.indexOf('const cmdPrecio'), cli.indexOf('const cmdCompara'));
    expect(precio).toContain('watchNamed(pageWatches.list(inbound.chatId), id)');
    expect(precio).not.toContain('x.id.startsWith(id)');
  });
});

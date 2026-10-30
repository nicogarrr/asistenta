import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/memory/sessions.js';

function store(fts = true): SessionStore {
  const s = new SessionStore({ db: new DatabaseSync(':memory:') });
  if (!fts) Object.defineProperty(s, 'ftsAvailable', { value: false });
  return s;
}

function seed(s: SessionStore): void {
  const main = s.begin('telegram:dm:1#main', 'Viaje a Lisboa');
  s.addTurn(main, 'user', 'reservamos el hotel en Lisboa para noviembre');
  s.end(main, 'Hotel en Lisboa reservado');
  const hilo = s.begin('telegram:dm:1#7', 'Lisboa: restaurantes');
  s.addTurn(hilo, 'user', 'qué cenar en Lisboa');
  s.end(hilo, 'Restaurantes en Lisboa');
  const otro = s.begin('telegram:dm:2#main', 'Lisboa de otro chat');
  s.addTurn(otro, 'user', 'Lisboa en otro chat');
  s.end(otro, 'Lisboa ajena');
}

describe.each([
  ['FTS', true],
  ['LIKE', false],
])('búsqueda de sesiones desde un hilo (%s)', (_name, fts) => {
  it('desde un hilo ve también el chat principal del mismo chat', () => {
    const s = store(fts);
    seed(s);
    const titles = s.search('Lisboa', 'telegram:dm:1#7').map((h) => h.title);
    expect(titles.sort()).toEqual(['Lisboa: restaurantes', 'Viaje a Lisboa']);
  });

  it('nunca cruza a otro chat', () => {
    const s = store(fts);
    seed(s);
    const titles = s.search('Lisboa', 'telegram:dm:2#5').map((h) => h.title);
    expect(titles).toEqual(['Lisboa de otro chat']);
  });

  it('desde el principal no ve los hilos, y un ámbito sin # se queda tal cual', () => {
    const s = store(fts);
    seed(s);
    expect(s.search('Lisboa', 'telegram:dm:1#main').map((h) => h.title)).toEqual([
      'Viaje a Lisboa',
    ]);
    const local = s.begin('local', 'Lisboa local');
    s.end(local, 'Lisboa');
    expect(s.search('Lisboa', 'local').map((h) => h.title)).toEqual(['Lisboa local']);
    expect(s.search('Lisboa').length).toBe(4);
  });
});

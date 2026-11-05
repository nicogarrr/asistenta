import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createPaginaVivaTool, PaginasVivas } from '../src/paginas-vivas.js';

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('');

describe('páginas vivas: «apunta en la página de gastos» va a la página que ya hay', () => {
  it('con la página «Mis gastos» creada, «la página de gastos» apunta ahí (no crea otra «Gastos»)', async () => {
    const store = new PaginasVivas(new DatabaseSync(':memory:'));
    store.guardar('Mis gastos', '- luz 40 €', 'chat', 1);
    const tool = createPaginaVivaTool({ store, allowed: () => true, now: () => 2 });
    const r = textOf(
      await tool.execute('t', {
        accion: 'anadir',
        titulo: 'la página de gastos',
        contenido: 'café 2 €',
      }),
    );
    expect(r).toBe('Apuntado en «Mis gastos».');
    expect(store.lista().map((p) => p.titulo)).toEqual(['Mis gastos']);
    expect(store.ver('Mis gastos')?.contenido).toBe('- luz 40 €\n- café 2 €');
  });

  it('si la página acaba en una tabla, la línea entra como fila de la tabla', () => {
    const store = new PaginasVivas(new DatabaseSync(':memory:'));
    store.guardar(
      'Gastos',
      '# Gastos\n\n| Concepto | Importe |\n|---|---|\n| luz | 40 € |\n',
      'chat',
      1,
    );
    store.anadir('gastos', 'café 2 €', 'chat', 2);
    store.anadir('gastos', 'súper: 25,50€', 'chat', 3);
    store.anadir('gastos', 'regalo Ana', 'chat', 4);
    expect(store.ver('gastos')?.contenido).toBe(
      '# Gastos\n\n| Concepto | Importe |\n|---|---|\n| luz | 40 € |\n| café | 2 € |\n| súper | 25,50€ |\n| regalo Ana | |',
    );
  });

  it('dos páginas parecidas: no adivina, crea la que se nombra', () => {
    const store = new PaginasVivas(new DatabaseSync(':memory:'));
    store.guardar('Mis gastos', '- a', 'chat', 1);
    store.guardar('Los gastos', '- b', 'chat', 1);
    store.anadir('gastos', 'café 2 €', 'chat', 2);
    expect(store.ver('gastos')?.contenido).toBe('- café 2 €');
    expect(store.ver('Mis gastos')?.contenido).toBe('- a');
  });
});

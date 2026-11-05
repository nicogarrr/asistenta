import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createPaginaVivaTool, PaginasVivas } from '../src/paginas-vivas.js';
import { Gate } from '../src/permissions.js';

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('');

describe('páginas vivas: apuntar una línea sin reescribir la página', () => {
  it('«apunta en la página de gastos: café 2 €» añade al final; si no existe, la crea', async () => {
    const store = new PaginasVivas(new DatabaseSync(':memory:'));
    const tool = createPaginaVivaTool({ store, allowed: () => true, now: () => 1 });
    expect(
      textOf(
        await tool.execute('t', {
          accion: 'anadir',
          titulo: 'la página de gastos',
          contenido: 'café 2 €',
        }),
      ),
    ).toContain('Página «Gastos» creada con esa línea');
    expect(
      textOf(
        await tool.execute('t', {
          accion: 'anadir',
          titulo: 'Gastos',
          contenido: 'súper 25 €\n| x | y |',
        }),
      ),
    ).toBe('Apuntado en «Gastos».');
    expect(store.ver('gastos')?.contenido).toBe('- café 2 €\n- súper 25 €\n| x | y |');
    expect(store.ver('gastos')?.veces).toBe(2);
    expect(
      textOf(await tool.execute('t', { accion: 'anadir', titulo: 'Gastos', contenido: '  ' })),
    ).toContain('Dime qué apunto');
  });

  it('la Gate lo trata como escritura local', () => {
    expect(
      new Gate().classifyEffect({ tool: 'pagina_viva', args: { accion: 'anadir' }, actor: 't' }),
    ).toBe('escribe-local');
  });
});

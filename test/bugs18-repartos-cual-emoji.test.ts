import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { initDeliveryStore } from '../src/mail/deliveries.js';
import { createDeliveriesTool } from '../src/tools/deliveries.js';

const NOW = new Date(2026, 10, 2, 10, 0).getTime();

// asis-bugs-18: el «¿Cuál?» de repartos cortaba el título del pedido a 60 unidades
// UTF-16 a ciegas; con un emoji justo en el corte quedaba medio carácter suelto («�»).
describe('repartos: «¿Cuál?» sin medio emoji', () => {
  it('un título con emoji en el carácter 60 no deja un sustituto suelto', async () => {
    const db = new DatabaseSync(':memory:');
    initDeliveryStore(db);
    const title = `${'a'.repeat(59)}📦 más texto`;
    for (const key of ['o:1', 'o:2'])
      db.prepare(
        'INSERT INTO deliveries (key, carrier, tracking, order_ref, title, status, status_at, notified, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)',
      ).run(key, 'Amazon', title, 'en_camino', NOW - 3_600_000, 'en_camino', NOW);
    const tool = createDeliveriesTool({ db, now: () => NOW });
    const r = await tool.execute('t', { recogido: 'Amazon' } as never);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/^¿Cuál\? Amazon \(«a{59}»\), Amazon \(«a{59}»\)\.$/);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

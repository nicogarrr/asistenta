import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { activeDeliveries, initDeliveryStore } from '../src/mail/deliveries.js';
import { createDeliveriesTool } from '../src/tools/deliveries.js';

const NOW = new Date(2026, 9, 31, 10, 0).getTime();

function setup() {
  const db = new DatabaseSync(':memory:');
  initDeliveryStore(db);
  const add = (key: string, carrier: string, tracking: string | null, title: string) =>
    db
      .prepare(
        'INSERT INTO deliveries (key, carrier, tracking, order_ref, title, status, status_at, notified, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
      )
      .run(key, carrier, tracking, title, 'para_recoger', NOW - 3_600_000, 'para_recoger', NOW);
  add('t:1', 'InPost', 'IP123', 'Tu paquete está listo para recoger');
  add('t:2', 'InPost', 'IP456', 'Tu paquete está listo para recoger');
  add('s:3', 'Paack', null, 'Tu pedido de libros llega hoy');
  add('s:4', 'Paack', null, 'Tu pedido de cascos llega hoy');
  const tool = createDeliveriesTool({ db, now: () => NOW });
  const call = async (args: Record<string, string>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  const statusOf = (key: string) => activeDeliveries(db, NOW).find((d) => d.key === key)?.status;
  return { call, statusOf };
}

describe('repartos: contestar al «¿Cuál?»', () => {
  it('«el segundo» quita el segundo de la lista que acaba de enseñar', async () => {
    const { call, statusOf } = setup();
    expect(await call({ recogido: 'el de InPost' })).toBe('¿Cuál? InPost (IP123), InPost (IP456).');
    expect(await call({ recogido: 'el segundo' })).toBe(
      'Hecho, quito InPost (IP456) de la lista: ya lo tienes.',
    );
    expect(statusOf('t:1')).toBe('para_recoger');
    expect(statusOf('t:2')).toBe('entregado');
  });

  it('«el último» y «el primero» también', async () => {
    const { call, statusOf } = setup();
    await call({ recogido: 'el de InPost' });
    await call({ recogido: 'el último' });
    expect(statusOf('t:2')).toBe('entregado');
    await call({ recogido: 'Paack' });
    await call({ recogido: 'el primero' });
    expect(statusOf('s:3')).toBe('entregado');
    expect(statusOf('s:4')).toBe('para_recoger');
  });

  it('sin número de seguimiento enseña de qué es cada uno', async () => {
    const { call } = setup();
    expect(await call({ recogido: 'Paack' })).toBe(
      '¿Cuál? Paack («Tu pedido de libros llega hoy»), Paack («Tu pedido de cascos llega hoy»).',
    );
  });

  it('«el segundo» sin lista antes no adivina', async () => {
    const { call, statusOf } = setup();
    expect(await call({ recogido: 'el segundo' })).toBe(
      'No encuentro ese paquete entre los que están en camino.',
    );
    expect(statusOf('t:2')).toBe('para_recoger');
  });
});

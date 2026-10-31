import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { activeDeliveries, initDeliveryStore } from '../src/mail/deliveries.js';
import { createDeliveriesTool } from '../src/tools/deliveries.js';

const NOW = new Date(2026, 9, 31, 10, 0).getTime();

function setup() {
  const db = new DatabaseSync(':memory:');
  initDeliveryStore(db);
  const add = (key: string, tracking: string) =>
    db
      .prepare(
        'INSERT INTO deliveries (key, carrier, tracking, order_ref, title, status, status_at, notified, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
      )
      .run(
        key,
        'InPost',
        tracking,
        'Tu paquete está listo',
        'para_recoger',
        NOW - 3_600_000,
        'para_recoger',
        NOW,
      );
  add('t:1', 'IP111');
  add('t:2', 'IP222');
  add('t:3', 'IP333');
  const tool = createDeliveriesTool({ db, now: () => NOW });
  const call = async (args: Record<string, string>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  const statusOf = (key: string) => activeDeliveries(db, NOW).find((d) => d.key === key)?.status;
  return { call, statusOf };
}

// gertru-gaps-8: al «¿Cuál? InPost (…), InPost (…)» la gente contesta «el 2» o «el número
// dos»; antes respondía «No encuentro ese paquete».
describe('repartos: «el 2», «el número dos», «el penúltimo»', () => {
  it('«el 2» elige el segundo de la lista', async () => {
    const { call, statusOf } = setup();
    expect(await call({ recogido: 'InPost' })).toMatch(/^¿Cuál\?/);
    expect(await call({ recogido: 'el 2' })).toBe(
      'Hecho, quito InPost (IP222) de la lista: ya lo tienes.',
    );
    expect(statusOf('t:1')).toBe('para_recoger');
    expect(statusOf('t:2')).toBe('entregado');
  });

  it('«el número tres», «el dos» y «el penúltimo»', async () => {
    const a = setup();
    await a.call({ recogido: 'InPost' });
    await a.call({ recogido: 'el número tres' });
    expect(a.statusOf('t:3')).toBe('entregado');

    const b = setup();
    await b.call({ recogido: 'InPost' });
    await b.call({ recogido: 'el dos' });
    expect(b.statusOf('t:2')).toBe('entregado');

    const c = setup();
    await c.call({ recogido: 'InPost' });
    await c.call({ recogido: 'el penúltimo' });
    expect(c.statusOf('t:2')).toBe('entregado');
  });

  it('un número fuera de la lista no marca nada', async () => {
    const { call, statusOf } = setup();
    await call({ recogido: 'InPost' });
    expect(await call({ recogido: 'el 7' })).toBe(
      'No encuentro ese paquete entre los que están en camino.',
    );
    expect(['t:1', 't:2', 't:3'].map(statusOf)).toEqual([
      'para_recoger',
      'para_recoger',
      'para_recoger',
    ]);
  });
});

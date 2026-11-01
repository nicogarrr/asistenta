import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { activeDeliveries, initDeliveryStore } from '../src/mail/deliveries.js';
import { createDeliveriesTool } from '../src/tools/deliveries.js';

const NOW = new Date(2026, 9, 31, 10, 0).getTime();

function setup() {
  const db = new DatabaseSync(':memory:');
  initDeliveryStore(db);
  const add = (
    key: string,
    carrier: string,
    tracking: string | null,
    title: string,
    status: string,
  ) =>
    db
      .prepare(
        'INSERT INTO deliveries (key, carrier, tracking, order_ref, title, status, status_at, notified, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
      )
      .run(key, carrier, tracking, title, status, NOW - 86_400_000, status, NOW - 86_400_000);
  add('t:1', 'InPost', 'IP123', 'Tu paquete está listo para recoger en el Locker', 'para_recoger');
  add('t:2', 'SEUR', 'ES999', 'Tu pedido de zapatillas está en reparto', 'en_reparto');
  add('t:3', 'Correos', 'PK777', 'Envío en camino', 'enviado');
  const tool = createDeliveriesTool({ db, now: () => NOW });
  const call = async (args: Record<string, string>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  return { db, call };
}

describe('repartos: «ya lo he recogido»', () => {
  it('marca el paquete por transportista o por número y deja de salir pendiente', async () => {
    const { db, call } = setup();
    expect(await call({ recogido: 'el de InPost' })).toBe(
      'Hecho, quito InPost (IP123) de la lista: ya lo tienes.',
    );
    expect(await call({ recogido: 'es999' })).toMatch(/^Hecho, quito SEUR \(ES999\)/);
    const estados = Object.fromEntries(activeDeliveries(db, NOW).map((d) => [d.carrier, d.status]));
    expect(estados).toEqual({ InPost: 'entregado', SEUR: 'entregado', Correos: 'enviado' });
    // A los tres días ya no aparece; lo demás sigue.
    expect(activeDeliveries(db, NOW + 3 * 86_400_000).map((d) => d.carrier)).toEqual(['Correos']);
  });

  it('por palabras del asunto; si hay dudas pregunta, y si no existe lo dice', async () => {
    const { call } = setup();
    expect(await call({ recogido: 'las zapatillas' })).toMatch(/^Hecho, quito SEUR/);
    expect(await call({ recogido: 'Amazon' })).toBe(
      'No encuentro ese paquete entre los que están en camino.',
    );
    expect(await call({ recogido: 'paquete en camino locker' })).toBe(
      '¿Cuál? InPost (IP123), Correos (PK777).',
    );
  });

  it('sin «recogido» sigue siendo solo mirar', async () => {
    const { call } = setup();
    expect(await call({})).toContain('InPost');
  });
});

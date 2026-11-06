import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompraStore } from '../src/compra.js';
import type { Metodo, ProductoApi, Transporte } from '../src/mercadona/api.js';
import {
  avisoSemanal,
  codigoPago,
  fijarDia,
  MERCA_PREFIX,
  type MercadonaDeps,
  mercadonaIntent,
  mercadonaPress,
} from '../src/mercadona/pedido.js';

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/mercadona/algolia.json'), 'utf8'),
) as Record<string, { hits: ProductoApi[] }>;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function montar(items: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'merca-'));
  dirs.push(dir);
  const lista = new CompraStore(join(dir, 'lista.json'), 'telegram:1');
  lista.add(items);
  const llamadas: Array<[Metodo, string, unknown]> = [];
  const transporte: Transporte = {
    sesion: async () => ({ uuid: 'u1', warehouse: 'mad1', postalCode: '28001' }),
    llamar: async (m, path, body) => {
      llamadas.push([m, path, body]);
      if (m === 'GET' && path.endsWith('/cart/'))
        return { status: 200, body: { id: 'c1', version: 3, lines: [] } };
      if (m === 'POST' && path.endsWith('/checkouts/'))
        return { status: 201, body: { id: 77, summary: { total: '12.34' } } };
      if (path.endsWith('/addresses/')) return { status: 200, body: { results: [{ id: 9 }] } };
      if (path.endsWith('/slots/'))
        return {
          status: 200,
          body: {
            results: [
              {
                id: 's0',
                start: '2026-11-07T08:00:00Z',
                end: '2026-11-07T09:00:00Z',
                available: false,
              },
              {
                id: 's1',
                start: '2026-11-07T09:00:00Z',
                end: '2026-11-07T10:00:00Z',
                available: true,
              },
            ],
          },
        };
      return { status: 200, body: {} };
    },
  };
  const pagar = vi.fn(async () => ({ pedido: '123456789' }));
  const deps: MercadonaDeps = {
    archivo: join(dir, 'mercadona.json'),
    chatKey: 'telegram:1',
    lista,
    transporte: () => transporte,
    buscar: async (q) => fx[q]?.hits ?? [],
    pagar,
  };
  return { deps, lista, llamadas, pagar };
}

async function hastaFranja(deps: MercadonaDeps) {
  let v = await mercadonaPress(deps, `${MERCA_PREFIX}si`);
  for (let n = 0; n < 5; n++) {
    const opcion = v.buttons.find((b) => /:e:\d+:\d+$/.test(b.action));
    if (!opcion) break;
    v = await mercadonaPress(deps, opcion.action);
  }
  return v;
}

describe('Mercadona: pedido semanal desde la lista', () => {
  it('«el pedido de Mercadona los lunes» y «haz el pedido de Mercadona» se entienden', () => {
    expect(mercadonaIntent('El pedido de Mercadona los lunes')).toEqual({ kind: 'dia', dia: 1 });
    expect(mercadonaIntent('pedido de mercadona los sábados a las 9')).toEqual({
      kind: 'dia',
      dia: 6,
      hora: 9,
    });
    expect(mercadonaIntent('haz el pedido de Mercadona')).toEqual({ kind: 'pedir' });
    expect(mercadonaIntent('pide lo de la lista')).toEqual({ kind: 'pedir' });
    expect(mercadonaIntent('faltan huevos')).toBeNull();
  });

  it('el viernes pregunta una vez con Sí/No/Editar; otro día o lista vacía, nada', () => {
    const { deps } = montar(['huevos', 'leche']);
    const jueves = Date.parse('2026-11-05T10:00:00Z');
    const viernes = Date.parse('2026-11-06T10:00:00Z'); // 11:00 en Madrid
    expect(avisoSemanal(deps, jueves, 'Europe/Madrid')).toBeNull();
    const v = avisoSemanal(deps, viernes, 'Europe/Madrid');
    expect(v?.text).toContain('Tienes esto en la lista: huevos, leche');
    expect(v?.text).toContain('¿Hago el pedido en Mercadona?');
    expect(v?.buttons.map((b) => b.label)).toEqual(['✅ Sí', '❌ No', '✏️ Editar']);
    expect(avisoSemanal(deps, viernes + 3600_000, 'Europe/Madrid')).toBeNull();
    fijarDia(deps.archivo, 4);
    expect(avisoSemanal(deps, jueves + 7 * 86400_000, 'Europe/Madrid')).not.toBeNull();
    const vacio = montar([]);
    expect(avisoSemanal(vacio.deps, viernes, 'Europe/Madrid')).toBeNull();
  });

  it('Sí → carrito, total y franjas; paga SOLO con «✅ Confirmar pedido», y una vez', async () => {
    const { deps, lista, llamadas, pagar } = montar(['huevos', 'leche']);
    const franjas = await hastaFranja(deps);
    expect(franjas.text).toContain('Total: 12,34 €');
    expect(franjas.buttons.filter((b) => b.label.startsWith('🚚'))).toHaveLength(1);
    const put = llamadas.find(([m, p]) => m === 'PUT' && p === '/customers/u1/cart/');
    expect((put?.[2] as { lines: unknown[] }).lines).toHaveLength(2);
    expect(pagar).not.toHaveBeenCalled();
    expect((await mercadonaPress(deps, `${MERCA_PREFIX}ok`)).text).toMatch(/franja/);
    expect(pagar).not.toHaveBeenCalled();
    const conf = await mercadonaPress(deps, `${MERCA_PREFIX}f:0`);
    expect(conf.buttons.map((b) => b.label)).toContain('✅ Confirmar pedido');
    expect(pagar).not.toHaveBeenCalled();
    const hecho = await mercadonaPress(deps, `${MERCA_PREFIX}ok`);
    expect(hecho.text).toContain('nº 123456789');
    expect(pagar).toHaveBeenCalledWith('77', '12.34');
    await mercadonaPress(deps, `${MERCA_PREFIX}ok`);
    expect(pagar).toHaveBeenCalledTimes(1);
    expect(lista.list().every((i) => i.done)).toBe(true);
  });

  it('cancelar o un error de la web nunca paga', async () => {
    const a = montar(['huevos']);
    await hastaFranja(a.deps);
    await mercadonaPress(a.deps, `${MERCA_PREFIX}x`);
    await mercadonaPress(a.deps, `${MERCA_PREFIX}ok`);
    expect(a.pagar).not.toHaveBeenCalled();
    const b = montar(['huevos']);
    b.deps.transporte = () => ({
      sesion: async () => ({ uuid: 'u1', warehouse: 'mad1', postalCode: null }),
      llamar: async () => ({ status: 500, body: null }),
    });
    const v = await hastaFranja(b.deps);
    expect(v.text).toContain('No se ha pagado nada');
    expect(b.pagar).not.toHaveBeenCalled();
  });

  it('sin sesión en la web, lo dice y no busca nada', async () => {
    const { deps } = montar(['huevos']);
    deps.transporte = () => ({
      sesion: async () => ({ uuid: null, warehouse: null, postalCode: null }),
      llamar: vi.fn(),
    });
    expect((await mercadonaPress(deps, `${MERCA_PREFIX}si`)).text).toContain(
      'No hay sesión de Mercadona',
    );
  });

  it('el pago en la web comprueba el total antes de pulsar', () => {
    const c = codigoPago('77', '12.34');
    expect(c.indexOf('12,34')).toBeLessThan(c.indexOf('.click()'));
  });
});

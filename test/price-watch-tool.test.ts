import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { egressUrlOf, taintSourceOf } from '../src/egress-taint.js';
import { Gate } from '../src/permissions.js';
import { createPriceWatchTool } from '../src/tools/price-watch.js';
import { PageWatchStore } from '../src/watch/pages.js';

function setup(fetchable = true) {
  const watches = new PageWatchStore(new DatabaseSync(':memory:'));
  let scope = 'chat-1';
  const tool = createPriceWatchTool({
    watches,
    scopeOf: () => scope,
    isFetchable: async () => fetchable,
  });
  const run = async (args: Record<string, unknown>) => {
    // biome-ignore lint/suspicious/noExplicitAny: test calls the tool with loose args
    const r = await tool.execute('t', args as any);
    const c = r.content[0];
    return {
      text: c && c.type === 'text' ? c.text : '',
      isError: Boolean((r as { isError?: boolean }).isError),
    };
  };
  return {
    watches,
    run,
    setScope: (s: string) => {
      scope = s;
    },
  };
}

describe('herramienta vigilar_precio', () => {
  it('crea una vigilancia en el registro de /vigila con objetivo en céntimos', async () => {
    const { watches, run } = setup();
    const r = await run({
      action: 'add',
      url: 'https://www.pccomponentes.com/x',
      target_eur: 399.9,
      label: 'Portátil',
    });
    expect(r.isError).toBe(false);
    const [w] = watches.list('chat-1');
    expect(w?.targetCents).toBe(39990);
    expect(w?.label).toBe('Portátil');
    expect(r.text).toContain(w?.id ?? 'x');
    expect(r.text).toContain('399,90');
  });

  it('repetir la misma url reconfigura sin duplicar', async () => {
    const { watches, run } = setup();
    await run({ action: 'add', url: 'https://tienda.example/p', target_eur: 500 });
    await run({ action: 'add', url: 'https://tienda.example/p', drop_pct: 15 });
    const rows = watches.list('chat-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dropPct).toBe(15);
    expect(rows[0]?.targetCents).toBeNull();
  });

  it('rechaza enlaces no públicos sin crear nada', async () => {
    const { watches, run } = setup(false);
    const r = await run({ action: 'add', url: 'http://192.168.1.1/admin' });
    expect(r.isError).toBe(true);
    expect(watches.list('chat-1')).toHaveLength(0);
  });

  it('valida objetivo y porcentaje', async () => {
    const { watches, run } = setup();
    expect((await run({ action: 'add', url: 'https://a.example/p', target_eur: -3 })).isError).toBe(
      true,
    );
    expect((await run({ action: 'add', url: 'https://a.example/p', drop_pct: 99 })).isError).toBe(
      true,
    );
    expect((await run({ action: 'add' })).isError).toBe(true);
    expect(watches.list('chat-1')).toHaveLength(0);
  });

  it('lista y quita solo las del chat que llama', async () => {
    const { watches, run, setScope } = setup();
    await run({ action: 'add', url: 'https://a.example/p', label: 'A' });
    setScope('chat-2');
    expect((await run({ action: 'list' })).text).toContain('No hay vigilancias');
    const id = watches.list('chat-1')[0]?.id ?? '';
    expect((await run({ action: 'remove', id })).isError).toBe(true);
    expect(watches.list('chat-1')).toHaveLength(1);
    setScope('chat-1');
    expect((await run({ action: 'list' })).text).toContain('A');
    expect((await run({ action: 'remove', id })).isError).toBe(false);
    expect(watches.list('chat-1')).toHaveLength(0);
  });

  it('el tope de vigilancias por chat se dice en vez de romper', async () => {
    const { run } = setup();
    for (let i = 0; i < 10; i++) await run({ action: 'add', url: `https://a.example/p${i}` });
    const r = await run({ action: 'add', url: 'https://a.example/p-extra' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('quita alguna');
  });
});

describe('vigilar_precio y la puerta de permisos', () => {
  it('add cuenta como salida a la red para la puerta de exfiltración', () => {
    expect(egressUrlOf('vigilar_precio', { action: 'add', url: 'https://x.example/?d=1' })).toBe(
      'https://x.example/?d=1',
    );
    expect(egressUrlOf('vigilar_precio', { action: 'list' })).toBeNull();
    expect(taintSourceOf('vigilar_precio', { action: 'add' })).toBeNull();
  });

  it('es una herramienta con efecto conocido: list lee, add/remove escriben en local', () => {
    const gate = new Gate({ taintGate: false });
    expect(
      gate.classifyEffect({ tool: 'vigilar_precio', args: { action: 'list' }, actor: 'local' }),
    ).toBe('lee');
    expect(
      gate.classifyEffect({
        tool: 'vigilar_precio',
        args: { action: 'add', url: 'https://a.example' },
        actor: 'local',
      }),
    ).toBe('escribe-local');
    expect(
      gate.classifyEffect({
        tool: 'vigilar_precio',
        args: { action: 'remove', id: 'x' },
        actor: 'local',
      }),
    ).toBe('escribe-local');
  });
});

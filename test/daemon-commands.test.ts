import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { buildCommandTable, dispatchCommand } from '../src/daemon/commands.js';

describe('buildCommandTable / dispatchCommand', () => {
  it('enruta por nombre y por alias, pasando args y el nombre usado', async () => {
    const run = vi.fn(async () => {});
    const table = buildCommandTable<string>([{ names: ['pendientes', 'followups'], run }]);
    const onUnknown = vi.fn(async () => {});
    await dispatchCommand(table, 'in', { name: 'followups', args: 'x y' }, onUnknown);
    expect(run).toHaveBeenCalledWith('in', 'x y', 'followups');
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it('un comando desconocido va a onUnknown con su nombre (también nombres de Object.prototype)', async () => {
    const table = buildCommandTable<string>([{ names: ['stop'], run: async () => {} }]);
    const onUnknown = vi.fn(async () => {});
    await dispatchCommand(table, 'in', { name: 'nope', args: '' }, onUnknown);
    await dispatchCommand(table, 'in', { name: 'constructor', args: '' }, onUnknown);
    expect(onUnknown.mock.calls).toEqual([['nope'], ['constructor']]);
  });

  it('el error del handler se propaga', async () => {
    const table = buildCommandTable<string>([
      {
        names: ['boom'],
        run: async () => {
          throw new Error('fallo');
        },
      },
    ]);
    await expect(
      dispatchCommand(table, 'in', { name: 'boom', args: '' }, async () => {}),
    ).rejects.toThrow('fallo');
  });

  it('un nombre registrado dos veces es un error, no un comando tapado', () => {
    expect(() =>
      buildCommandTable<string>([
        { names: ['tv'], run: async () => {} },
        { names: ['tele', 'tv'], run: async () => {} },
      ]),
    ).toThrow(/tv/);
  });
});

describe('tabla de comandos de cli.ts', () => {
  const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const start = src.indexOf('const commandTable = buildCommandTable<Inbound>([');
  const end = src.indexOf('\n  ]);', start);
  const block = src.slice(start, end);
  const names = [...block.matchAll(/names: \[([^\]]*)\]/g)].flatMap((m) =>
    [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((n) => n[1]),
  );

  it('existe y no repite nombres', () => {
    expect(start).toBeGreaterThan(0);
    expect(names.length).toBeGreaterThan(50);
    expect(new Set(names).size).toBe(names.length);
  });

  it('cada comando del menú de Telegram tiene handler', () => {
    const missing = TELEGRAM_COMMANDS.map((c) => c.command).filter((c) => !names.includes(c));
    expect(missing).toEqual([]);
  });

  it('onMessage ya no lleva el switch de comandos', () => {
    expect(src).not.toMatch(/switch \(command\.name\)/);
  });
});

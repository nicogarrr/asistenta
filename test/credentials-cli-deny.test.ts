import { describe, expect, it } from 'vitest';
import { cuentasCommand } from '../src/credentials/export.js';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const shell = (command: string): ToolCall => ({
  tool: 'shell',
  args: { command },
  actor: 'asistenta',
});

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    fullControl: true,
    approver: async (c) => {
      asked.push(String(c.args.command));
      return true;
    },
  });
  return { g, asked };
}

describe('pa cuentas borrar|cambiar: solo el dueño en su terminal', () => {
  it.each([
    'pa cuentas borrar wallapop.es',
    'echo wallapop.es | pa cuentas borrar wallapop.es',
    'node dist/cli.js cuentas cambiar wallapop.es',
    'pa  cuentas   CAMBIAR wallapop.es; powershell Get-Clipboard',
  ])('el shell del modelo no puede: %s', async (command) => {
    const { g, asked } = gate();
    const d = await g.check(S, shell(command));
    expect(d.verdict).toBe('deny');
    expect(asked).toEqual([]);
  });

  it('tampoco tecleándolo en una terminal', async () => {
    const { g } = gate();
    const d = await g.check(S, {
      tool: 'computer',
      args: { action: 'type', text: 'pa cuentas borrar wallapop.es' },
      actor: 'asistenta',
    });
    expect(d.verdict).toBe('deny');
  });

  it('listar sigue igual', async () => {
    const { g } = gate();
    expect((await g.check(S, shell('pa cuentas listar'))).verdict).not.toBe('deny');
  });

  it.each(['borrar', 'cambiar'])(
    'sin terminal delante, %s se niega y no toca nada',
    async (cmd) => {
      const out: string[] = [];
      const touched: string[] = [];
      const m = new Map<string, string>([
        ['site:wallapop.es:username', 'nico@example.com'],
        ['site:wallapop.es:password', 'x'],
        ['cuenta:wallapop.es', JSON.stringify({ status: 'activa' })],
      ]);
      const vault = {
        get: async (k: string) => m.get(k),
        set: async (k: string) => void touched.push(k),
        delete: async (k: string) => {
          touched.push(k);
          return true;
        },
        list: async () => [...m.keys()],
      };
      const rc = await cuentasCommand([cmd, 'wallapop.es'], {
        vault: vault as never,
        out: (s) => out.push(s),
        isTty: false,
      });
      expect(rc).not.toBe(0);
      expect(out.join(' ')).toMatch(/terminal/);
      expect(touched).toEqual([]);
    },
  );
});

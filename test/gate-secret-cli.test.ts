import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const shell = (command: string): ToolCall => ({
  tool: 'shell',
  args: { command },
  actor: 'asistenta',
});

// Control total (opt-in del vault): todo sin preguntar salvo dinero y credenciales.
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

describe('el shell del modelo no saca contraseñas del vault', () => {
  it.each([
    'echo EXPORTAR | pa cuentas exportar keepass C:\\Users\\nico\\x.csv',
    'node dist/cli.js cuentas exportar bitwarden out.json',
    'pa cuentas copiar wallapop.es; powershell Get-Clipboard',
    'pa vault get provider:apiKey',
    'pa "vault"   get telegram:token',
    'pa vault get site:wallapop.es:pwd',
  ])('deniega: %s', async (command) => {
    const { g, asked } = gate();
    const d = await g.check(S, shell(command));
    expect(d.verdict).toBe('deny');
    expect(d.reason).toMatch(/terminal/);
    expect(asked).toEqual([]);
  });

  it.each(['pa vault list', 'pa cuentas listar', 'dir', 'pa vault set-stdin mailRead:password'])(
    'no cambia: %s',
    async (command) => {
      const { g } = gate();
      expect((await g.check(S, shell(command))).verdict).not.toBe('deny');
    },
  );

  it('tampoco escribiéndolo en una terminal con el teclado', async () => {
    const { g } = gate();
    const d = await g.check(S, {
      tool: 'computer',
      args: { action: 'type', text: 'pa cuentas exportar keepass x.csv' },
      actor: 'asistenta',
    });
    expect(d.verdict).toBe('deny');
  });
});

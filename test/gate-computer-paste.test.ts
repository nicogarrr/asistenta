import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const type = (text: string): ToolCall => ({
  tool: 'computer',
  args: { action: 'type', text },
  actor: 'asistenta',
});
const key = (k: string): ToolCall => ({
  tool: 'computer',
  args: { action: 'key', key: k },
  actor: 'asistenta',
});
const shell = (command: string): ToolCall => ({
  tool: 'shell',
  args: { command },
  actor: 'asistenta',
});
// Control total: todo sin preguntar salvo dinero y credenciales.
const gate = () => new Gate({ fullControl: true, approver: async () => true });

async function run(calls: ToolCall[]): Promise<string[]> {
  const g = gate();
  const out: string[] = [];
  for (const c of calls) out.push((await g.check(S, c)).verdict);
  return out;
}

describe('pegar con ctrl+v en una terminal también se lee', () => {
  it('lo último tecleado (en Windows `type` pega) se cuenta al pegarlo', async () => {
    const v = await run([
      type('et telegram:botToken'),
      key('enter'),
      type('pa vault g'),
      key('ctrl+v'),
    ]);
    expect(v).toEqual(['allow', 'allow', 'allow', 'deny']);
  });

  it('shift+insert igual', async () => {
    const v = await run([type('et x'), key('enter'), type('pa vault g'), key('shift+insert')]);
    expect(v.at(-1)).toBe('deny');
  });

  it.each([
    ['pa ', 'ctrl+v'],
    ['pa vault ', 'ctrl+v'],
    ['node dist/cli.js cuentas ', 'ctrl+shift+v'],
  ])('«%s» + texto copiado que no se conoce (%s) se deniega', async (before, paste) => {
    const v = await run([key('ctrl+c'), type(before), key(paste)]);
    expect(v.at(-1)).toBe('deny');
  });

  it('meter texto construido en el portapapeles desde el shell se deniega', async () => {
    const d = await gate().check(S, shell(`('pa va','ult get x') -join '' | Set-Clipboard`));
    expect(d.verdict).toBe('deny');
  });
});

describe('pegar lo normal no cambia', () => {
  it.each([
    [[key('ctrl+c'), key('ctrl+l'), key('ctrl+v'), key('enter')]],
    [[type('https://example.com'), key('ctrl+a'), key('ctrl+v'), key('enter')]],
    [[key('ctrl+c'), type('revisar las cuentas de '), key('ctrl+v')]],
    [[key('ctrl+c'), type('pa status'), key('enter'), key('ctrl+v'), key('enter')]],
    [[type('npx vitest run'), key('ctrl+a'), key('ctrl+c'), key('ctrl+v'), key('enter')]],
  ])('%#', async (calls) => {
    expect((await run(calls)).every((v) => v === 'allow')).toBe(true);
  });

  it.each(['"hola" | clip', 'Get-Content notas.txt | Set-Clipboard', 'pa vault list | clip'])(
    '%s',
    async (cmd) => {
      expect((await gate().check(S, shell(cmd))).verdict).toBe('allow');
    },
  );
});

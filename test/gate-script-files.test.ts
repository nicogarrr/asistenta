import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const write = (path: string, content: string): ToolCall => ({
  tool: 'write',
  args: { path, content },
  actor: 'asistenta',
});
const shell = (command: string): ToolCall => ({
  tool: 'shell',
  args: { command },
  actor: 'asistenta',
});
// Control total: todo sin preguntar salvo dinero y credenciales.
const gate = () => new Gate({ fullControl: true, approver: async () => true });

describe('escribir un script que saca secretos es lo mismo que ejecutarlo', () => {
  it.each([
    ['C:/Users/nico/Desktop/a.ps1', 'pa vault get telegram:botToken'],
    ['C:/Users/nico/a.bat', '@echo off\r\npa vault get provider:apiKey'],
    ['C:/Users/nico/A.CMD', 'pa cuentas exportar'],
    ['/tmp/x.sh', "node -e \"import('./dist/vault.js').then(v => v.vaultGet('x'))\""],
    ['C:/Users/nico/b.ps1', '$v = "vault"; pa $v get x'],
    ['C:/Users/nico/c.ps1', 'powershell -enc cABhACAAdgBhAHUAbAB0AA=='],
  ])('deniega %s', async (path, content) => {
    expect((await gate().check(S, write(path, content))).verdict).toBe('deny');
  });

  it.each([
    ['C:/Users/nico/notas.md', 'Para ver una clave: pa vault get <k>'],
    ['C:/Users/nico/arranca.ps1', 'pa status\r\npa vault list'],
    ['C:/Users/nico/test.bat', 'npx vitest run --maxWorkers=2'],
  ])('no cambia %s', async (path, content) => {
    expect((await gate().check(S, write(path, content))).verdict).toBe('allow');
  });
});

describe('piezas pegadas con + en el shell', () => {
  it.each([
    "Set-Content a.ps1 ('pa vault g' + 'et x'); ./a.ps1",
    '$o = "pa va"+"ult get x"; $o | Out-File a.ps1',
    "Add-Content a.ps1 ('pa cuentas ' + 'copiar gmail')",
  ])('deniega: %s', async (command) => {
    expect((await gate().check(S, shell(command))).verdict).toBe('deny');
  });

  it.each(['echo ("hola " + "mundo")', '$n = "a" + "b"; echo $n', 'git log --oneline -5'])(
    'no cambia: %s',
    async (command) => {
      expect((await gate().check(S, shell(command))).verdict).toBe('allow');
    },
  );
});

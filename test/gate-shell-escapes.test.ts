import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const shell = (command: string): ToolCall => ({
  tool: 'shell',
  args: { command },
  actor: 'asistenta',
});
// Control total: todo sin preguntar salvo dinero y credenciales.
const gate = () => new Gate({ fullControl: true, approver: async () => true });

describe('`pa vault get` partido con escapes o comillas del shell también se deniega', () => {
  it.each([
    'cmd /c pa vault g^et telegram:botToken',
    'pa vault g`et telegram:botToken',
    'pa vault "g"et telegram:botToken',
    "pa va''ult get provider:apiKey",
    'pa cuentas cop"iar" gmail',
    'node dist/cli.js cuentas ex^portar',
    'Set-Alias p pa; p vault get x',
    'function v { pa vault @args }; v get x',
    'doskey v=pa vault $* & v get x',
    "sal p pa; $g='get'; p vault $g x",
  ])('deniega: %s', async (command) => {
    expect((await gate().check(S, shell(command))).verdict).toBe('deny');
  });

  it.each([
    'pa vault list',
    'pa status',
    'npm test',
    'npx vitest run --maxWorkers=2',
    'powershell -ExecutionPolicy Bypass -Command "npm run build"',
    'git commit -m "don\'t forget the get step"',
    'echo "vault" > notas.txt',
    'cmd /c "echo hola ^& echo adios"',
  ])('no cambia: %s', async (command) => {
    expect((await gate().check(S, shell(command))).verdict).toBe('allow');
  });
});

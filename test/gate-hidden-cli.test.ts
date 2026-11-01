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

describe('el shell del modelo no esconde `pa vault get` para saltarse la regla', () => {
  it.each([
    '$v="vault"; pa $v get telegram:token',
    "$a='va'+'ult'; pa $a get provider:apiKey",
    'cmd /c "set v=vault&& pa %v% get x"',
    'pa vault $accion telegram:token',
    'node dist/cli.js $sub get x',
    'powershell -enc cABhACAAdgBhAHUAbAB0ACAAZwBlAHQAIAB4AA==',
    'pwsh -NoProfile -EncodedCommand cABhACAAdgBhAHUAbAB0AA==',
    'powershell.exe -ec cABhAA==',
    'iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("cABhAA==")))',
    'Invoke-Expression ("pa va" + "ult get x")',
    "iex (-join ('p','a',' ','v','a','u','l','t',' ','g','e','t'))",
    '$c = "pa"; $s = "cuentas"; & $c $s copiar x',
  ])('deniega: %s', async (command) => {
    const d = await gate().check(S, shell(command));
    expect(d.verdict).toBe('deny');
  });

  it.each([
    'pa vault list',
    'pa status',
    'pa tareas',
    'npx vitest run test/vault-stdin-process.test.ts',
    'npm test',
    '$x = 1; echo $x',
    'Get-ChildItem $env:TEMP',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Date"',
    '& $exe --version',
    'git log --oneline -3 -- src/vault.ts',
    'Get-Content README.md | Select-String vault',
    '"{0} archivos" -f 3',
  ])('no cambia: %s', async (command) => {
    const d = await gate().check(S, shell(command));
    expect(d.verdict).toBe('allow');
  });
});

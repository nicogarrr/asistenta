/**
 * Con un comando de shell ya aprobado, durante 90 s pasaban sin preguntar cosas que dejan el
 * PC expuesto sin borrar nada:
 * - instalar certificados (uno raíz deja leer cualquier web cifrada) o guardar/borrar
 *   credenciales de Windows (`cmdkey`, `vaultcmd`);
 * - cambiar para siempre variables como el PATH (`setx`, `SetEnvironmentVariable(…, 'Machine')`);
 * - cambiar de dónde se bajan los paquetes (`npm config set registry`, `pip config set`) o qué
 *   se ejecuta en cada commit (`git config core.hooksPath`);
 * - escribir en el archivo hosts (redirige webs, como la del banco).
 * Solo endurece: consultar y las variables de la sesión siguen en la ventana.
 */
import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const call = (tool: string, args: Record<string, unknown> = {}): ToolCall => ({
  tool,
  args,
  actor: 'owner',
});

function gateWith() {
  const asked: string[] = [];
  const gate = new Gate({
    approver: async (c, reason) => {
      asked.push(`${c.tool}: ${reason}`);
      return true;
    },
  });
  return { gate, asked };
}

const RIESGOS = [
  'Import-Certificate -FilePath x.cer -CertStoreLocation Cert:\\LocalMachine\\Root',
  'Import-PfxCertificate -FilePath x.pfx -CertStoreLocation Cert:\\CurrentUser\\My',
  'cmdkey /add:servidor /user:x /pass:y',
  'cmdkey /generic:x /user:y /pass:z',
  'cmdkey /delete:x',
  'vaultcmd /deletecreds:"Windows Credentials" /credtype:x /identity:y',
  'setx PATH "C:\\evil;%PATH%"',
  'setx /M PATH x',
  "[Environment]::SetEnvironmentVariable('PATH','x','Machine')",
  '[Environment]::SetEnvironmentVariable("Path", $p, "User")',
  "[System.Environment]::SetEnvironmentVariable('X','y',[System.EnvironmentVariableTarget]::Machine)",
  'npm config set registry http://evil',
  'npm config set @x:registry http://evil',
  'pnpm config set registry http://evil',
  'pip config set global.index-url http://evil',
  'pip3 config set global.extra-index-url http://evil',
  'git config --global core.hooksPath C:\\x',
  'git config core.hooksPath .hooks',
  "Add-Content C:\\Windows\\System32\\drivers\\etc\\hosts '1.2.3.4 banco.es'",
  "Set-Content -Path C:\\Windows\\System32\\drivers\\etc\\hosts -Value ''",
  'echo 1.2.3.4 banco.es >> C:\\Windows\\System32\\drivers\\etc\\hosts',
  "'1.2.3.4 x' | Out-File -Append $env:windir\\System32\\drivers\\etc\\hosts",
];

describe('ventana de shell: certificados, credenciales, PATH, origen de paquetes y hosts preguntan', () => {
  it.each(RIESGOS)('con la ventana abierta, «%s» pregunta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    const d = await gate.check(S, call('shell', { command }));
    expect(d.reason).toBe('approved by owner');
    expect(asked).toHaveLength(2);
  });

  it('consultar y lo de la sesión siguen dentro de la ventana', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    for (const command of [
      'Get-ChildItem Cert:\\CurrentUser\\My',
      'cmdkey /list',
      'vaultcmd /list',
      'echo %PATH%',
      '$env:PATH',
      "[Environment]::GetEnvironmentVariable('PATH','Machine')",
      "$env:FOO='bar'",
      'set FOO=bar',
      'npm config get registry',
      'npm config list',
      'pip config list',
      'git config --get core.hooksPath',
      'git config user.name',
      'Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts',
      'type C:\\Windows\\System32\\drivers\\etc\\hosts',
      "Set-Content notas.txt 'hola'",
      'echo hola > notas.txt',
      'git config --global user.email a@b.c',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

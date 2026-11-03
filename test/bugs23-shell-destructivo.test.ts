/**
 * Comandos que pierden trabajo o bajan las defensas del PC sin parecer «borrar»: `git clean
 * -fdx`, `git reset --hard`, `git push --force`, `git checkout -- .`, `robocopy /mir`,
 * borrar copias de sombra o registros de eventos, `bcdedit`, apagar Defender o el
 * cortafuegos, crear cuentas, `cipher /w` o desactivar la red. Con un comando ya aprobado,
 * la ventana de 90 s los dejaba pasar sin preguntar, también tras leer una web. Regla de
 * Nico (#1895): lo destructivo pregunta siempre. Solo endurece.
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
  'git clean -fdx',
  'git reset --hard HEAD~3',
  'git push --force origin main',
  'robocopy C:\\a C:\\b /mir',
  'vssadmin delete shadows /all /quiet',
  'wevtutil cl System',
  'bcdedit /set {default} recoveryenabled no',
  'Set-MpPreference -DisableRealtimeMonitoring $true',
  'netsh advfirewall set allprofiles state off',
  'net user hacker P4ss /add',
  'cipher /w:C:\\',
  'Disable-NetAdapter -Name Wi-Fi',
  'git checkout -- .',
];
describe('ventana de shell: perder trabajo o bajar defensas pregunta', () => {
  it.each(RIESGOS)('con la ventana abierta, «%s» pregunta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    await gate.check(S, call('shell', { command }));
    expect(asked).toHaveLength(2);
  });

  it('git de lectura y diagnóstico de red siguen dentro de la ventana', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    for (const command of [
      'git status',
      'git log --oneline -5',
      'git diff',
      'netsh wlan show interfaces',
      'Get-MpComputerStatus',
      'net user',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

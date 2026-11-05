/**
 * bugs28: con un comando de shell ya aprobado, durante 90 s pasaban sin preguntar cosas que
 * dejan a Nico sin asistente o descolocan el PC:
 * - matar node.exe (la propia Asistenta), PowerShell o el Explorador;
 * - cerrar la sesión de Windows (`logoff`) o soltar la red (`ipconfig /release`, desactivar
 *   la interfaz);
 * - esconder carpetas como de sistema (`attrib +h +s`), crear uniones o enlaces (`mklink /j`,
 *   `New-Item -ItemType Junction`), cambiar la hibernación o el plan de energía
 *   (`powercfg /h off`, `-change`), un alias de git que ejecuta comandos (`alias.x "!…"`).
 * Solo endurece: cerrar otro programa o consultar sigue dentro de la ventana.
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
  'taskkill /f /im node.exe',
  'taskkill /im node.exe /t',
  'Stop-Process -Name node -Force',
  'Stop-Process -Name explorer',
  'Get-Process node | Stop-Process',
  'Stop-Process -Id $PID',
  'logoff',
  'ipconfig /release',
  'netsh interface set interface "Wi-Fi" disabled',
  'attrib +h +s C:\\Users\\nico\\Documents',
  'mklink /j C:\\a C:\\Windows',
  'New-Item -ItemType Junction -Path C:\\a -Target C:\\Windows',
  'powercfg /h off',
  'powercfg -change standby-timeout-ac 0',
  'git config --global alias.st "!rm -rf ."',
];

describe('ventana de shell: matar a Asistenta, cerrar sesión, soltar la red y similares preguntan', () => {
  it.each(RIESGOS)('con la ventana abierta, «%s» pregunta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    const d = await gate.check(S, call('shell', { command }));
    expect(d.reason).toBe('approved by owner');
    expect(asked).toHaveLength(2);
  });

  it('cerrar otro programa o consultar sigue dentro de la ventana', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    for (const command of [
      'taskkill /im chrome.exe /f',
      'Stop-Process -Name notepad',
      'Get-Process node',
      'attrib C:\\x',
      'attrib -h C:\\x',
      'powercfg /list',
      'powercfg /batteryreport',
      'git config --global user.name Nico',
      'git config --global alias.st status',
      'ipconfig /all',
      'ipconfig /flushdns',
      'netsh interface show interface',
      'New-Item -ItemType Directory C:\\x',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

/**
 * La regla de Nico (#1895/#1942: «lo destructivo pregunta siempre») no veía desinstalar ni
 * las formas de PowerShell de bajar defensas o borrar servicios, tareas, usuarios y discos:
 * con un comando ya aprobado, durante 90 s pasaban sin preguntar `winget uninstall`,
 * `pip uninstall`, `wsl --unregister` (borra la distro entera), `Set-NetFirewallProfile
 * -Enabled False` (el cortafuegos; `netsh` sí preguntaba), `Disable-ComputerRestore`,
 * `sc delete`, `schtasks /delete`, `Remove-LocalUser`, `Clear-Disk`… También tras leer una
 * web con «Siempre». Solo endurece: consultar (list, query, Get-*) sigue en la ventana.
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
  'winget uninstall Spotify',
  'choco uninstall git -y',
  'pip uninstall -y requests',
  'npm uninstall -g typescript',
  'yarn remove x',
  'Uninstall-Package foo',
  'Get-AppxPackage *xbox* | Remove-AppxPackage',
  'wsl --unregister Ubuntu',
  'Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled False',
  'Disable-NetFirewallRule -DisplayName x',
  'Disable-ComputerRestore -Drive C:\\',
  'manage-bde -off C:',
  'Disable-BitLocker -MountPoint C:',
  'sc delete WinDefend',
  'sc.exe delete foo',
  'Set-Service -Name WinDefend -StartupType Disabled',
  'schtasks /delete /tn Backup /f',
  'Unregister-ScheduledTask -TaskName x -Confirm:$false',
  'Remove-LocalUser -Name bob',
  'Clear-Disk -Number 1 -RemoveData',
  'Remove-Partition -DriveLetter D',
  'docker system prune -af',
  'docker volume rm datos',
];

describe('ventana de shell: desinstalar y bajar defensas por PowerShell preguntan', () => {
  it.each(RIESGOS)('con la ventana abierta, «%s» pregunta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    const d = await gate.check(S, call('shell', { command }));
    expect(d.reason).toBe('approved by owner');
    expect(asked).toHaveLength(2);
  });

  it('consultar sigue dentro de la ventana', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    for (const command of [
      'winget list',
      'winget search spotify',
      'pip list',
      'pip show requests',
      'npm ls -g',
      'Get-NetFirewallProfile',
      'Get-Service WinDefend',
      'sc query WinDefend',
      'schtasks /query',
      'Get-ScheduledTask',
      'Get-LocalUser',
      'Get-Disk',
      'docker ps',
      'docker volume ls',
      'wsl --list',
      'Set-NetFirewallProfile -Enabled True',
      'apt list --installed',
      'Set-Service -Name Spooler -StartupType Automatic',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

/**
 * Con un comando de shell ya aprobado, durante 90 s pasaban sin preguntar:
 * - crear usuarios, cambiar su contraseña (`net user x clave`, `Set-LocalUser -Password`) o
 *   meterlos en Administradores (`Add-LocalGroupMember`); borrarlos ya preguntaba;
 * - abrir el PC a control remoto (`Enable-PSRemoting`, `winrm quickconfig`, TrustedHosts *);
 * - compartir carpetas con todos (`New-SmbShare`, `net share x=C:\\`) o encender SMB1;
 * - meter o sacar el PC de un dominio o cambiarle el nombre.
 * Solo endurece: consultar usuarios, recursos compartidos y la configuración sigue en la ventana.
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
  'New-LocalUser x',
  'Set-LocalUser -Name x -AccountNeverExpires',
  'Add-LocalGroupMember -Group Administrators -Member x',
  'Add-LocalGroupMember Administradores x',
  'Enable-LocalUser Administrator',
  'net user x newpass',
  'net user Administrador Secreto1',
  'net.exe user x newpass /domain',
  'Enable-PSRemoting -Force',
  'Enable-PSRemoting',
  'Set-Item WSMan:\\localhost\\Client\\TrustedHosts *',
  "Set-Item -Path WSMan:\\localhost\\Client\\TrustedHosts -Value '*' -Force",
  'winrm quickconfig -force',
  'winrm qc',
  'New-SmbShare -Name x -Path C:\\ -FullAccess Everyone',
  'net share x=C:\\ /grant:everyone,full',
  'Set-SmbServerConfiguration -EnableSMB1Protocol $true',
  'Grant-SmbShareAccess -Name x -AccountName Everyone -AccessRight Full',
  'Rename-Computer -NewName x',
  'Add-Computer -DomainName x',
  'Remove-Computer',
  'Reset-ComputerMachinePassword',
];

describe('ventana de shell: usuarios, control remoto, carpetas compartidas y dominio preguntan', () => {
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
      'Get-LocalUser',
      'Get-LocalGroupMember Administrators',
      'net user',
      'net user x',
      'net user x /domain',
      'net localgroup',
      'Get-PSSessionConfiguration',
      'Get-Item WSMan:\\localhost\\Client\\TrustedHosts',
      'winrm enumerate winrm/config/listener',
      'winrm get winrm/config',
      'Get-SmbShare',
      'net share',
      'net view',
      'Get-SmbServerConfiguration',
      'Get-ComputerInfo',
      'hostname',
      'Test-ComputerSecureChannel',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

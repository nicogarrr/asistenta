/**
 * Con un comando de shell ya aprobado, durante 90 s pasaban sin preguntar:
 * - quitar componentes de Windows (`Disable-WindowsOptionalFeature`, `Remove-WindowsCapability`,
 *   `dism /disable-feature`, `/remove-package`, `/resetbase`), cuando activarlos ya preguntaba;
 * - publicar o retirar paquetes (`npm publish`, `npm unpublish`, `cargo publish`/`yank`,
 *   `twine upload`) y borrar un repositorio o una release de GitHub (`gh repo delete`);
 * - abrir o quitar reglas del cortafuegos por PowerShell (`New-/Remove-NetFirewallRule`;
 *   `netsh advfirewall` ya preguntaba) y quitar drivers o desactivar dispositivos.
 * Solo endurece: listar, consultar, empaquetar y compilar siguen en la ventana.
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
  'Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All',
  'Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
  'dism /online /disable-feature /featurename:SMB1Protocol',
  'dism /disable-feature /online /featurename:x /norestart',
  'DISM.exe /Online /Remove-Package /PackageName:Package_for_KB5000001',
  'dism /online /cleanup-image /startcomponentcleanup /resetbase',
  'npm publish',
  'npm publish --access public',
  'npm unpublish mi-paquete --force',
  'pnpm publish --no-git-checks',
  'yarn npm publish',
  'cargo publish',
  'cargo yank --version 1.0.0',
  'twine upload dist/*',
  'gh repo delete nicogarrr/prueba --yes',
  'gh release delete v1.0 -y',
  'New-NetFirewallRule -DisplayName RDP -Direction Inbound -LocalPort 3389 -Action Allow',
  'Remove-NetFirewallRule -DisplayName "Bloquear"',
  'pnputil /delete-driver oem12.inf /uninstall',
  'Disable-PnpDevice -InstanceId USB\\VID_1 -Confirm:$false',
];

describe('ventana de shell: quitar componentes, publicar paquetes y tocar el cortafuegos preguntan', () => {
  it.each(RIESGOS)('con la ventana abierta, «%s» pregunta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    const d = await gate.check(S, call('shell', { command }));
    expect(d.reason).toBe('approved by owner');
    expect(asked).toHaveLength(2);
  });

  it('listar, consultar, empaquetar y compilar siguen dentro de la ventana', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    for (const command of [
      'Get-WindowsOptionalFeature -Online',
      'Get-WindowsCapability -Online',
      'dism /online /get-features',
      'dism /online /cleanup-image /scanhealth',
      'npm pack',
      'npm view react version',
      'npm run build',
      'npm whoami',
      'gh repo view nicogarrr/asistenta',
      'gh release list',
      'Get-NetFirewallRule -DisplayName RDP',
      'pnputil /enum-drivers',
      'Get-PnpDevice -Class Camera',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

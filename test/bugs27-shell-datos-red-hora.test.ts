/**
 * Con un comando de shell ya aprobado, durante 90 s pasaban sin preguntar cosas que borran
 * datos o descolocan el PC:
 * - `docker compose down -v` (se lleva los volúmenes con los datos), `docker rmi -f`,
 *   `kubectl delete`, `sqlite3 … "DROP TABLE … / DELETE FROM …"`;
 * - parar o desactivar tareas programadas (la de arranque de Asistenta incluida);
 * - cambiar el DNS o las rutas, borrar las wifis guardadas;
 * - cambiar la fecha o la zona horaria del PC (descuadra recordatorios y certificados);
 * - cifrar carpetas (`cipher /e`) o cambiar sus permisos (`Set-Acl`), dejar de compartir
 *   carpetas o quitar roles de Windows.
 * Solo endurece: consultar sigue dentro de la ventana.
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
  'docker compose down -v',
  'docker-compose down --volumes',
  'docker compose -f deploy.yml down --remove-orphans -v',
  'docker rmi -f nginx',
  'docker image rm --force nginx',
  'kubectl delete ns prod',
  'sqlite3 memory.db "DROP TABLE memories"',
  "sqlite3 C:\\pa\\memory.db 'DELETE FROM goals;'",
  'Disable-ScheduledTask -TaskName Asistenta',
  'Stop-ScheduledTask -TaskName Asistenta',
  'schtasks /change /tn Asistenta /disable',
  'schtasks /end /tn Asistenta',
  'Set-DnsClientServerAddress -InterfaceAlias Wi-Fi -ServerAddresses 1.2.3.4',
  'netsh interface ip set dns Wi-Fi static 1.2.3.4',
  'netsh wlan delete profile name=*',
  'route delete 0.0.0.0',
  'route -f',
  'Remove-NetRoute -DestinationPrefix 0.0.0.0/0 -Confirm:$false',
  'Set-Date 2020-01-01',
  'Set-TimeZone -Id UTC',
  'tzutil /s "UTC"',
  'w32tm /config /manualpeerlist:evil /update',
  'cipher /e C:\\Users\\nico\\Docs',
  'Set-Acl C:\\x $acl',
  'Remove-SmbShare -Name docs -Force',
  'Uninstall-WindowsFeature Web-Server',
];

describe('ventana de shell: borrar datos de docker/bases, tareas, DNS, hora, cifrado y permisos preguntan', () => {
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
      'docker ps',
      'docker compose up -d',
      'docker compose down',
      'docker compose logs -f',
      'kubectl get pods',
      'sqlite3 memory.db "SELECT count(*) FROM memories"',
      'Get-ScheduledTask -TaskName Asistenta',
      'schtasks /query /tn Asistenta',
      'Get-DnsClientServerAddress',
      'netsh wlan show profiles',
      'route print',
      'Get-TimeZone',
      'tzutil /g',
      'w32tm /query /status',
      'Get-Acl C:\\x',
      'Get-SmbShare',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

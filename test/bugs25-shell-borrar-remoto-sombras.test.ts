/**
 * Con un comando de shell ya aprobado, durante 90 s pasaban sin preguntar:
 * - borrar ramas remotas (`git push origin --delete x`, `git push origin :x`), tags, un
 *   worktree con cambios (`git worktree remove --force`) o lo inalcanzable (`git gc --prune=now`);
 * - borrar copias de sombra por CIM/WMI (`Get-CimInstance Win32_ShadowCopy | Remove-CimInstance`,
 *   vssadmin ya preguntaba), catálogos de copia de seguridad (`wbadmin delete`), el registro
 *   de eventos (`Clear-EventLog`; wevtutil cl ya preguntaba) o el diario USN (`fsutil`).
 * Solo endurece: subir, listar y consultar siguen en la ventana.
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
  'git push origin --delete feature',
  'git push --delete origin feature',
  'git push origin -d feature',
  'git push origin :feature',
  'Get-CimInstance Win32_ShadowCopy | Remove-CimInstance',
  'Get-WmiObject Win32_ShadowCopy | Remove-WmiObject',
  'Clear-EventLog -LogName Security',
  'Remove-EventLog -LogName App',
  'wbadmin delete catalog -quiet',
  'wbadmin delete systemstatebackup',
  'fsutil usn deletejournal /d C:',
  'git worktree remove --force ../wt',
  'git gc --prune=now',
  'git tag -d v1.0',
];

describe('ventana de shell: borrar ramas remotas, copias de sombra y registros preguntan', () => {
  it.each(RIESGOS)('con la ventana abierta, «%s» pregunta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    const d = await gate.check(S, call('shell', { command }));
    expect(d.reason).toBe('approved by owner');
    expect(asked).toHaveLength(2);
  });

  it('subir, listar y consultar siguen dentro de la ventana', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    for (const command of [
      'git push',
      'git push origin main',
      'git push -u origin main',
      'git push origin HEAD:refs/heads/x',
      'git push origin main:main',
      'Get-CimInstance Win32_ShadowCopy',
      'Get-EventLog -LogName System -Newest 10',
      'wbadmin get versions',
      'fsutil fsinfo drives',
      'git worktree list',
      'git gc',
      'git tag',
      'git tag v1.0',
      'git push --tags',
      'git log -d',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

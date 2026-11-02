import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

/**
 * Ventana de confianza de la tarea para shell (regla de Nico, 2-nov-2026):
 * aprobado un comando de la tarea que él pidió, los siguientes comandos de
 * lectura o diagnóstico no repreguntan; lo destructivo, instalar cosas y lo
 * que toca dinero o credenciales preguntan siempre, uno a uno.
 */
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

describe('ventana de confianza de shell', () => {
  it('aprobado un comando de diagnóstico, los siguientes de la tarea no repreguntan', async () => {
    const { gate, asked } = gateWith();
    const first = await gate.check(S, call('shell', { command: 'pa --help' }));
    expect(first.reason).toBe('approved by owner');
    for (const command of ['Get-ChildItem Env:', 'pa status', 'git log --oneline -3']) {
      const d = await gate.check(S, call('shell', { command }));
      expect(d.verdict).toBe('allow');
      expect(d.reason).toBe('within the approval window');
    }
    expect(asked.filter((a) => a.startsWith('shell'))).toHaveLength(1);
  });

  it('lo destructivo pregunta aunque la ventana esté abierta', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'pa --help' }));
    const d = await gate.check(S, call('shell', { command: 'Remove-Item -Recurse dist' }));
    expect(d.reason).toBe('approved by owner');
    expect(asked.filter((a) => a.startsWith('shell'))).toHaveLength(2);
  });

  it('instalar cosas pregunta aunque la ventana esté abierta', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'pa --help' }));
    for (const command of ['npm install lodash', 'pip install requests', 'winget install x.y']) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked.filter((a) => a.startsWith('shell'))).toHaveLength(4);
  });

  it('un número con pinta de tarjeta pregunta aunque la ventana esté abierta', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'pa --help' }));
    await gate.check(S, call('shell', { command: 'echo 4111111111111111' }));
    expect(asked.filter((a) => a.startsWith('shell'))).toHaveLength(2);
  });
});

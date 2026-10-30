import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const pc = (args: Record<string, unknown>): ToolCall => ({
  tool: 'computer',
  args,
  actor: 'agent',
});

function gate(answer: boolean, asked: string[]): Gate {
  // La misma política del daemon (createDaemonGate): captura y mover libres, ventana de 90 s.
  return new Gate({
    allow: ['read'],
    allowActions: ['computer:screenshot', 'computer:move'],
    grantWindowMs: 90_000,
    approver: async (c) => {
      asked.push(String(c.args.action));
      return answer;
    },
  });
}

describe('la ventana de confianza solo la abre una aprobación humana', () => {
  it('una captura libre no da teclado y ratón sin preguntar', async () => {
    const asked: string[] = [];
    const g = gate(false, asked);
    expect((await g.check('s', pc({ action: 'screenshot' }))).verdict).toBe('allow');
    expect((await g.check('s', pc({ action: 'key', key: 'win+r' }))).verdict).toBe('deny');
    expect((await g.check('s', pc({ action: 'type', text: 'powershell' }))).verdict).toBe('deny');
    expect((await g.check('s', pc({ action: 'click', x: 1, y: 1 }))).verdict).toBe('deny');
    expect(asked).toEqual(['key', 'type', 'click']);
  });

  it('mover el ratón tampoco abre la ventana', async () => {
    const asked: string[] = [];
    const g = gate(false, asked);
    await g.check('s', pc({ action: 'move', x: 5, y: 5 }));
    expect((await g.check('s', pc({ action: 'type', text: 'x' }))).verdict).toBe('deny');
    expect(asked).toEqual(['type']);
  });

  it('tras una aprobación humana la ventana sigue cubriendo la tarea (sin regresión)', async () => {
    const asked: string[] = [];
    const g = gate(true, asked);
    expect((await g.check('s', pc({ action: 'click', x: 1, y: 1 }))).verdict).toBe('allow');
    expect((await g.check('s', pc({ action: 'type', text: 'hola' }))).verdict).toBe('allow');
    expect(asked).toEqual(['click']);
  });
});

import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

// Una aprobación de `computer` abre 90 s en los que el resto de clics y teclas
// de la tarea no vuelve a preguntar. Los atajos del sistema (Win+R abre
// «Ejecutar», Win+X el menú de administración, Ctrl+Alt+Supr, Alt+F4,
// Ctrl+Shift+Esc) quedan fuera de esa ventana: preguntan siempre.

function counting() {
  const asked: string[] = [];
  const gate = new Gate({
    protectedPaths: [],
    grantWindowMs: 90_000,
    approver: (call) => {
      asked.push(JSON.stringify(call.args));
      return true;
    },
  });
  return { gate, asked };
}

describe('type tras un atajo del sistema', () => {
  it('Win+R y luego «cmd⏎» en el mismo lote: el type también pregunta', async () => {
    const { gate, asked } = counting();
    await gate.check('s', { tool: 'computer', args: { action: 'click', x: 1, y: 2 }, actor: 'me' });
    await gate.check('s', {
      tool: 'computer',
      args: { action: 'key', key: 'win+r' },
      actor: 'batch',
    });
    const typed = await gate.check('s', {
      tool: 'computer',
      args: { action: 'type', text: 'cmd\n' },
      actor: 'batch',
    });
    expect(typed.reason).not.toBe('within the approval window');
    expect(asked).toHaveLength(3);
    // Solo el primero: el siguiente type vuelve a ir por la ventana.
    const next = await gate.check('s', {
      tool: 'computer',
      args: { action: 'type', text: 'dir' },
      actor: 'batch',
    });
    expect(next.reason).toBe('within the approval window');
    expect(asked).toHaveLength(3);
  });

  it('sin atajo del sistema, el type sigue en la ventana (sin cambio)', async () => {
    const { gate, asked } = counting();
    await gate.check('s', { tool: 'computer', args: { action: 'click', x: 1, y: 2 }, actor: 'me' });
    await gate.check('s', {
      tool: 'computer',
      args: { action: 'key', key: 'ctrl+c' },
      actor: 'batch',
    });
    const typed = await gate.check('s', {
      tool: 'computer',
      args: { action: 'type', text: 'hola' },
      actor: 'batch',
    });
    expect(typed.reason).toBe('within the approval window');
    expect(asked).toHaveLength(1);
  });
});

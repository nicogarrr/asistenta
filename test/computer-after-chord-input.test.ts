import { describe, expect, it } from 'vitest';
import { Gate, isSystemKeyChord } from '../src/permissions.js';

// Tras un atajo del sistema (Win+R, Win+X…) el primer paso de entrada —tecla,
// clic, arrastre o texto— actúa sobre lo que ese atajo abrió: pregunta aunque la
// ventana de 90 s siga abierta. Y un arrastre es «manejar el escritorio» igual
// que un clic.

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
const step = (args: Record<string, unknown>) => ({ tool: 'computer', args, actor: 'batch' });

describe('paso tras un atajo del sistema', () => {
  it('Win+R y luego «key enter»: la tecla pregunta; la siguiente vuelve a la ventana', async () => {
    const { gate, asked } = counting();
    await gate.check('s', { tool: 'computer', args: { action: 'click', x: 1, y: 2 }, actor: 'me' });
    await gate.check('s', step({ action: 'key', key: 'win+r' }));
    const enter = await gate.check('s', step({ action: 'key', key: 'enter' }));
    expect(enter.reason).not.toBe('within the approval window');
    expect(asked).toHaveLength(3);
    const next = await gate.check('s', step({ action: 'key', key: 'tab' }));
    expect(next.reason).toBe('within the approval window');
  });

  it('Win+X y luego un clic: el clic pregunta', async () => {
    const { gate, asked } = counting();
    await gate.check('s', { tool: 'computer', args: { action: 'click', x: 1, y: 2 }, actor: 'me' });
    await gate.check('s', step({ action: 'key', key: 'win+x' }));
    const click = await gate.check('s', step({ action: 'click', x: 5, y: 5 }));
    expect(click.reason).not.toBe('within the approval window');
    expect(asked).toHaveLength(3);
  });

  it('sin atajo del sistema, tecla y clic siguen en la ventana (sin cambio)', async () => {
    const { gate, asked } = counting();
    await gate.check('s', { tool: 'computer', args: { action: 'click', x: 1, y: 2 }, actor: 'me' });
    await gate.check('s', step({ action: 'key', key: 'ctrl+c' }));
    expect((await gate.check('s', step({ action: 'key', key: 'enter' }))).reason).toBe(
      'within the approval window',
    );
    expect(asked).toHaveLength(1);
  });

  it('un arrastre sin aprobación previa pregunta', async () => {
    const { gate, asked } = counting();
    const d = await gate.check('s', {
      tool: 'computer',
      args: { action: 'drag', x: 1, y: 1, toX: 9, toY: 9 },
      actor: 'me',
    });
    expect(d.verdict).toBe('allow');
    expect(asked).toHaveLength(1);
  });
});

describe('isSystemKeyChord: más formas de escribir el atajo', () => {
  it.each(['os+r', 'start+x', 'winkey+r', 'ctrl+esc', '#r', '^%{DEL}', '%{F4}', '^{ESC}'])(
    '%s es atajo del sistema',
    (k) => expect(isSystemKeyChord(k)).toBe(true),
  );
  it.each(['ctrl+c', 'enter', 'alt+tab', '^c', '+a', '%f'])('%s no lo es', (k) =>
    expect(isSystemKeyChord(k)).toBe(false),
  );
});

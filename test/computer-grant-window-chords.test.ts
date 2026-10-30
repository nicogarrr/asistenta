import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { Gate, isSystemKeyChord } from '../src/permissions.js';

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

describe('ventana de 90 s de computer y atajos del sistema', () => {
  it('reconoce los atajos del sistema y deja pasar los normales', () => {
    for (const k of [
      'win+r',
      'Win+X',
      'windows+d',
      'meta+e',
      'ctrl+alt+delete',
      'Ctrl + Alt + Supr',
      'alt+f4',
      'ctrl+shift+esc',
      'win',
      '{LWIN}+r',
      'altgr+ctrl+t',
    ]) {
      expect(isSystemKeyChord(k), k).toBe(true);
    }
    for (const k of [
      'enter',
      'ctrl+s',
      'ctrl+c',
      'alt+tab',
      'shift+tab',
      'f4',
      'ctrl+f4',
      'escape',
      '+',
      '',
    ]) {
      expect(isSystemKeyChord(k), k).toBe(false);
    }
  });

  it('un clic aprobado abre la ventana para teclas normales, no para win+r', async () => {
    const { gate, asked } = counting();
    const click = await gate.check('s', {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 2 },
      actor: 'me',
    });
    expect(click.verdict).toBe('allow');
    expect(asked).toHaveLength(1);
    const enter = await gate.check('s', {
      tool: 'computer',
      args: { action: 'key', key: 'enter' },
      actor: 'me',
    });
    expect(enter.reason).toBe('within the approval window');
    expect(asked).toHaveLength(1);
    for (const key of ['win+r', 'win+x', 'ctrl+alt+delete', 'alt+f4', 'ctrl+shift+esc']) {
      const d = await gate.check('s', {
        tool: 'computer',
        args: { action: 'key', key },
        actor: 'me',
      });
      expect(d.reason, key).not.toBe('within the approval window');
    }
    expect(asked).toHaveLength(6);
  });

  it('dentro de un lote, el paso win+r también pregunta (actor batch)', async () => {
    const { gate, asked } = counting();
    await gate.check('s', { tool: 'computer', args: { action: 'click', x: 1, y: 2 }, actor: 'me' });
    const step = await gate.check('s', {
      tool: 'computer',
      args: { action: 'key', key: 'win+r' },
      actor: 'batch',
    });
    expect(step.reason).not.toBe('within the approval window');
    expect(asked).toHaveLength(2);
  });

  it('la pregunta de computer avisa de la ventana de 90 s', () => {
    const q = formatApproval(
      { tool: 'computer', args: { action: 'click', x: 10, y: 20 }, actor: 'me' },
      'r',
    ).question;
    expect(q).toMatch(/90 s/);
    expect(q).toMatch(/Win\+R/);
    const batch = formatApproval(
      {
        tool: 'computer',
        args: { action: 'batch', actions: [{ action: 'click', x: 1, y: 1 }] },
        actor: 'me',
      },
      'r',
    ).question;
    expect(batch).toMatch(/90 s/);
    const none = formatApproval(
      { tool: 'computer', args: { action: 'click', x: 1, y: 1 }, actor: 'me' },
      'r',
      { grantWindowMs: 0 },
    ).question;
    expect(none).not.toMatch(/90 s/);
    // Una pregunta denegada (secreto) no promete ninguna ventana.
    const secret = formatApproval(
      { tool: 'computer', args: { action: 'type', text: 'x', secret: true }, actor: 'me' },
      'r',
    ).question;
    expect(secret).not.toMatch(/90 s/);
  });
});

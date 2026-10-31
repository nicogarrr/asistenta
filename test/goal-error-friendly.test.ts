import { describe, expect, it } from 'vitest';
import { formatGoalMessage } from '../src/goals/notify.js';

// Un objetivo cuyo tick fallaba por red avisaba «falló en su último tick: fetch failed».
describe('aviso de error de un objetivo', () => {
  it('dice la causa en claro, sin el error crudo', () => {
    const msg = formatGoalMessage('error', { title: 'Ahorro' }, 'fetch failed');
    expect(msg).not.toContain('fetch failed');
    expect(msg).toContain('No puedo hablar con el modelo');
    expect(msg).toContain('"Ahorro"');
    expect(msg).toContain('Lo reintento en el siguiente');
  });

  it('una clave caducada se distingue de la red caída', () => {
    expect(formatGoalMessage('error', { title: 'X' }, '401 Unauthorized')).toMatch(/clave/);
  });
});

import { describe, expect, it } from 'vitest';
import { formatGoalMessage } from '../src/goals/notify.js';
import { GOAL_TICK_STOPPED } from '../src/goals/parado.js';
import { STOPPED_DETAIL } from '../src/tools/system.js';

describe('«parado con /stop» en palabras', () => {
  it('el objetivo parado por Nico se dice en claro, sin comandos ni «fallo interno»', () => {
    const text = formatGoalMessage('error', { title: 'Ordenar facturas' }, GOAL_TICK_STOPPED);
    expect(text).toBe(
      '🎯 "Ordenar facturas": esta vez no lo he avanzado porque paraste el chat antes de que empezara. Sigo en el siguiente intento.',
    );
    expect(text).not.toMatch(/\/stop|fallo interno|falló/);
  });

  it('los demás fallos del objetivo siguen igual', () => {
    expect(formatGoalMessage('error', { title: 'X' }, 'fetch failed')).toMatch(
      /falló en su último/,
    );
  });

  it('la reproducción cortada tampoco nombra comandos', () => {
    expect(STOPPED_DETAIL).toBe('lo paraste tú');
  });
});

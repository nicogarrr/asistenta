import { describe, expect, it } from 'vitest';
import { resolveDay } from '../src/tasks/board.js';

// asis-bugs-1: una fecha en formato AAAA-MM-DD que no existe («2026-02-30», «2026-13-01»)
// se aceptaba tal cual: la tarea quedaba en un día fuera del calendario y no salía en
// ninguna vista de día ni de semana.
const now = new Date(2026, 10, 1, 10);

describe('tablero: fechas AAAA-MM-DD que no existen', () => {
  it('rechaza días y meses imposibles', () => {
    expect(resolveDay('2026-02-30', now)).toBeNull();
    expect(resolveDay('2026-02-29', now)).toBeNull();
    expect(resolveDay('2026-13-01', now)).toBeNull();
    expect(resolveDay('2026-11-31', now)).toBeNull();
    expect(resolveDay('2026-00-10', now)).toBeNull();
  });

  it('las fechas reales siguen valiendo, también el 29 de febrero de un año bisiesto', () => {
    expect(resolveDay('2026-11-30', now)).toBe('2026-11-30');
    expect(resolveDay('el 2028-02-29', now)).toBe('2028-02-29');
    expect(resolveDay('2027-01-01', now)).toBe('2027-01-01');
  });
});

import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

const effect = (action: string) =>
  new Gate({ approver: () => true }).classifyEffect({
    tool: 'correo_reglas',
    args: { action },
    actor: 'local',
  });

describe('correo_reglas: qué hace cada acción en el mundo', () => {
  it('mirar el buzón o las reglas es lectura; guardar o borrar una regla es local', () => {
    for (const a of ['resumen', 'reglas', 'bajas', 'limpiar_vista', 'baja_vista'])
      expect(effect(a), a).toBe('lee');
    expect(effect('crear')).toBe('escribe-local');
    expect(effect('borrar')).toBe('escribe-local');
  });

  it('mover correo, darse de baja o algo desconocido no tiene clase: se pregunta', () => {
    for (const a of ['limpiar', 'baja', 'otra', '']) expect(effect(a), a).toBeNull();
  });
});

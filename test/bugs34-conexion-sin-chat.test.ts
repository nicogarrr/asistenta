import { afterEach, describe, expect, it } from 'vitest';
import {
  alCaerConexion,
  avisarConexionCaida,
  entregarAvisosPendientes,
} from '../src/conexion-caida.js';

// bugs-34: el aviso «🔌 Google se ha desconectado» (#2284) iba al último chat. Con el PC
// recién arrancado no hay último chat (el resumen de la mañana pide el calendario antes de
// que Nico escriba nada): el aviso se perdía, el token ya estaba borrado y no volvía a caer,
// así que nunca se enteraba. Ahora se guarda y sale con el siguiente mensaje.

afterEach(() => alCaerConexion(null));

describe('aviso de conexión caída sin chat al que decirlo', () => {
  it('se guarda y sale en cuanto hay chat, una sola vez', () => {
    const got: string[] = [];
    let chat = false;
    alCaerConexion((s, t) => {
      if (!chat) return false;
      got.push(`${s}: ${t.split('\n')[0]}`);
      return true;
    });
    const t0 = Date.UTC(2026, 10, 11, 7, 0);
    expect(avisarConexionCaida('google', t0)).toBe(false);
    expect(got).toEqual([]);
    expect(entregarAvisosPendientes(t0 + 1000)).toBe(0);
    chat = true;
    expect(entregarAvisosPendientes(t0 + 60_000)).toBe(1);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^google: 🔌 Google se ha desconectado/);
    // Ya entregado: no se repite, y cuenta para el tope de 12 h.
    expect(entregarAvisosPendientes(t0 + 120_000)).toBe(0);
    expect(avisarConexionCaida('google', t0 + 3_600_000)).toBe(false);
    expect(got).toHaveLength(1);
  });

  it('con chat a mano sale al momento, como antes', () => {
    const got: string[] = [];
    alCaerConexion((s) => {
      got.push(s);
    });
    expect(avisarConexionCaida('spotify')).toBe(true);
    expect(got).toEqual(['spotify']);
    expect(entregarAvisosPendientes()).toBe(0);
  });
});

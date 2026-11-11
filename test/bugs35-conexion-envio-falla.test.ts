import { afterEach, describe, expect, it } from 'vitest';
import {
  alCaerConexion,
  avisarConexionCaida,
  entregarAvisosPendientes,
} from '../src/conexion-caida.js';

// bugs-35 (revisión de #2315): el aviso «🔌 Google se ha desconectado» al DM del dueño se
// mandaba «y listo»: si Telegram fallaba al enviarlo (red recién levantada al arrancar el
// PC, un 5xx…), se daba por entregado, contaba para el tope de 12 h y no volvía a salir
// nunca (el token ya estaba borrado). Ahora un envío fallido lo deja pendiente.

afterEach(() => alCaerConexion(null));
const t0 = Date.UTC(2026, 10, 11, 7, 0);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('aviso de conexión caída: un envío que falla no cuenta como entregado', () => {
  it('si el envío falla, queda pendiente y sale con el siguiente mensaje', async () => {
    const got: string[] = [];
    let telegramOk = false;
    alCaerConexion(async (s) => {
      if (!telegramOk) throw new Error('fetch failed');
      got.push(s);
      return true;
    });
    avisarConexionCaida('google', t0);
    await tick();
    expect(got).toEqual([]);
    telegramOk = true;
    expect(entregarAvisosPendientes(t0 + 60_000)).toBe(1);
    await tick();
    expect(got).toEqual(['google']);
    // Entregado: no se repite.
    expect(entregarAvisosPendientes(t0 + 120_000)).toBe(0);
  });

  it('si el envío falla, el tope de 12 h no se gasta: una nueva caída avisa', async () => {
    const got: string[] = [];
    let ok = false;
    alCaerConexion(async (s) => {
      if (!ok) return false;
      got.push(s);
      return true;
    });
    avisarConexionCaida('spotify', t0);
    await tick();
    ok = true;
    avisarConexionCaida('spotify', t0 + 3_600_000);
    await tick();
    expect(got).toEqual(['spotify']);
  });

  it('un envío que va bien sigue contando como entregado (una vez cada 12 h)', async () => {
    const got: string[] = [];
    alCaerConexion(async (s) => {
      got.push(s);
      return true;
    });
    avisarConexionCaida('google', t0);
    await tick();
    expect(avisarConexionCaida('google', t0 + 3_600_000)).toBe(false);
    await tick();
    expect(got).toEqual(['google']);
    expect(entregarAvisosPendientes(t0 + 3_700_000)).toBe(0);
  });
});

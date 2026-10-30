/**
 * Cadena de encendido/apagado de la tele, extraida del cableado de la CLI para
 * poder probarla sin tele: Glasshouse -> SSAP -> (solo encender) Wake-on-LAN.
 *
 * Reglas (auditor #104 r1, sin cambios):
 * - Glasshouse primero. Solo si NUNCA llego a recibir la orden
 *   (GlasshouseUnavailableError) se prueba SSAP; un rechazo o una escritura
 *   ambigua se propagan tal cual: respetan la config de la tele.
 * - SSAP: encender = turnOnScreen (tele en reposo con pantalla apagada),
 *   apagar = system/turnOff.
 * Nuevo:
 * - Encender con la tele apagada del todo (SSAP no conecta: TvUnreachableError,
 *   no se envio nada) y MAC guardada -> paquete Wake-on-LAN y espera corta
 *   hasta que la tele responda, para decir la verdad sobre si encendio.
 * - Sin MAC: el error de siempre, con la pista de como activarlo.
 */
import { GlasshouseUnavailableError } from './glasshouse.js';
import { TvUnreachableError } from './lgtv.js';

export interface TvPowerDeps {
  /** Glasshouse /api/control; ausente = no configurado. */
  gh?: (action: 'powerOn' | 'powerOff') => Promise<void>;
  /** Request SSAP contra la tele emparejada (lanza si no hay pairing o no conecta). */
  ssap: (uri: string, payload: Record<string, unknown>) => Promise<unknown>;
  /** Wake-on-LAN; ausente = sin MAC guardada. */
  wake?: () => Promise<unknown>;
  /** ¿Responde la tele por SSAP? Para confirmar el encendido por red. */
  probe?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** Cuanto esperar a que la tele responda tras el WoL (por defecto 20 s). */
  wakeWaitMs?: number;
  /** Cada cuanto preguntar (por defecto 2 s). */
  pollMs?: number;
  info?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface TvPowerOutcome {
  via: 'glasshouse' | 'ssap' | 'wol';
  /** true = comprobado que responde; false = comprobado que aun no; null = no se comprueba. */
  verified: boolean | null;
}

export const WOL_HINT =
  'Si estaba apagada del todo, puedo encenderla por red (Wake-on-LAN): guarda su MAC con `pa tv mac AA:BB:CC:DD:EE:FF` ' +
  'y activa en la tele "Encender con Wi-Fi" (Ajustes > General > Dispositivos).';

export async function tvPower(on: boolean, deps: TvPowerDeps): Promise<TvPowerOutcome> {
  const info = deps.info ?? (() => {});
  if (deps.gh) {
    try {
      await deps.gh(on ? 'powerOn' : 'powerOff');
      return { via: 'glasshouse', verified: null };
    } catch (err) {
      if (!(err instanceof GlasshouseUnavailableError)) throw err;
      info('tv power: Glasshouse inalcanzable, pruebo SSAP', { err: String(err) });
    }
  }
  if (!on) {
    await deps.ssap('system/turnOff', {});
    return { via: 'ssap', verified: null };
  }
  try {
    await deps.ssap('com.webos.service.tvpower/power/turnOnScreen', {});
    return { via: 'ssap', verified: null };
  } catch (err) {
    if (!(err instanceof TvUnreachableError)) throw err;
    if (!deps.wake) {
      throw new TvUnreachableError(`${err.message} ${WOL_HINT}`);
    }
    info('tv power: SSAP no conecta, envio Wake-on-LAN', { err: String(err) });
  }
  await deps.wake();
  if (!deps.probe) return { via: 'wol', verified: null };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = Math.max(0, deps.wakeWaitMs ?? 20_000);
  const step = Math.max(1, deps.pollMs ?? 2_000);
  for (let waited = 0; waited < budget; waited += step) {
    await sleep(step);
    if (await deps.probe().catch(() => false)) return { via: 'wol', verified: true };
  }
  return { via: 'wol', verified: false };
}

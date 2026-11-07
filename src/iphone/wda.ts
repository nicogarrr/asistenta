/**
 * Cliente de WebDriverAgent (WDA) para manejar el iPhone desde el PC: opcional, detrás de
 * `PA_IPHONE_WDA=1` (Nico, 7 nov: «Todo lo que tengan estas cosas quiero desarrollarlo yo»).
 *
 * WDA es un servidor HTTP open source que corre en el iPhone como prueba de interfaz de
 * Apple (XCTest). Desde Windows se arranca con go-ios o pymobiledevice3 y queda en
 * `http://127.0.0.1:8100` (docs/iphone-wda.md). Con él se ve la pantalla, se lee el
 * árbol de accesibilidad y se toca o se escribe como lo haría un dedo.
 *
 * Ideas tomadas de cómo trabaja POKI (solo ideas; su código es AGPL y aquí no hay nada suyo):
 * - Un toque cuya petición no llegó a salir (conexión rechazada) es «no enviado»: se
 *   puede repetir. Un toque sin respuesta es «desconocido»: puede que se hiciera, así que
 *   se mira la pantalla antes de repetir, nunca a ciegas.
 * - Una sola sesión, que se vuelve a crear si WDA la ha perdido.
 *
 * Sin probar en un iPhone real: los tests solo usan un WDA simulado.
 */

import { sliceSafe } from '../text.js';
import { resumirArbolWda } from './wda-texto.js';

export type WdaFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Cómo acabó una orden que mueve el teléfono. */
export type WdaEntrega = 'hecho' | 'no-enviado' | 'desconocido';

export class WdaError extends Error {
  readonly entrega: Exclude<WdaEntrega, 'hecho'>;
  constructor(message: string, entrega: Exclude<WdaEntrega, 'hecho'>) {
    super(message);
    this.entrega = entrega;
  }
}

export const WDA_URL_POR_DEFECTO = 'http://127.0.0.1:8100';

/** ¿Está activado? Solo con `PA_IPHONE_WDA=1`: es opcional y experimental. */
export function wdaActivo(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_IPHONE_WDA ?? '').trim() === '1';
}

/** La URL de WDA: `PA_IPHONE_WDA_URL` (http/https) o la de por defecto. */
export function wdaUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PA_IPHONE_WDA_URL ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+(:\d+)?$/.test(raw) ? raw : WDA_URL_POR_DEFECTO;
}

function esRechazo(err: unknown): boolean {
  const s = String(
    (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? '',
  );
  return s === 'ECONNREFUSED' || s === 'ENOTFOUND' || s === 'EHOSTUNREACH';
}

export interface WdaEstado {
  listo: boolean;
  ios?: string;
  dispositivo?: string;
  ip?: string;
}

export class WdaClient {
  readonly #base: string;
  readonly #fetch: WdaFetch;
  readonly #timeoutMs: number;
  #sesion: string | null = null;

  constructor(opts: { baseUrl: string; fetch?: WdaFetch; timeoutMs?: number }) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? (globalThis.fetch as unknown as WdaFetch);
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async #pedir(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Awaited<ReturnType<WdaFetch>>;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      if (esRechazo(err)) {
        throw new WdaError(
          `WebDriverAgent no responde en ${this.#base}: ¿está arrancado (go-ios runwda) y el puerto reenviado?`,
          'no-enviado',
        );
      }
      throw new WdaError(
        'WebDriverAgent no ha contestado a tiempo: puede que la orden se hiciera. Mira la pantalla antes de repetirla.',
        'desconocido',
      );
    }
    const texto = await res.text().catch(() => '');
    let datos: unknown = null;
    try {
      datos = texto ? JSON.parse(texto) : null;
    } catch {
      datos = null;
    }
    if (!res.ok) {
      const msg =
        (datos as { value?: { message?: string } } | null)?.value?.message ?? `HTTP ${res.status}`;
      // WDA contestó con error: no hizo la acción.
      throw new WdaError(
        `WebDriverAgent rechazó la orden: ${sliceSafe(String(msg), 200)}`,
        'no-enviado',
      );
    }
    return datos;
  }

  async estado(): Promise<WdaEstado> {
    const d = (await this.#pedir('GET', '/status')) as {
      value?: {
        ready?: boolean;
        os?: { version?: string };
        device?: string;
        ios?: { ip?: string };
      };
    } | null;
    const v = d?.value ?? {};
    return {
      listo: v.ready !== false,
      ...(v.os?.version ? { ios: v.os.version } : {}),
      ...(v.device ? { dispositivo: v.device } : {}),
      ...(v.ios?.ip ? { ip: v.ios.ip } : {}),
    };
  }

  async #idSesion(): Promise<string> {
    if (this.#sesion) return this.#sesion;
    const d = (await this.#pedir('POST', '/session', { capabilities: { alwaysMatch: {} } })) as {
      sessionId?: string;
      value?: { sessionId?: string };
    } | null;
    const id = d?.sessionId ?? d?.value?.sessionId;
    if (!id) throw new WdaError('WebDriverAgent no ha abierto sesión.', 'no-enviado');
    this.#sesion = id;
    return id;
  }

  /** Una orden dentro de la sesión; si WDA la perdió (404), se abre otra una vez. */
  async #enSesion(method: string, sub: string, body?: unknown): Promise<unknown> {
    const id = await this.#idSesion();
    try {
      return await this.#pedir(method, `/session/${id}${sub}`, body);
    } catch (err) {
      if (
        err instanceof WdaError &&
        err.entrega === 'no-enviado' &&
        /HTTP 404|invalid session/i.test(err.message)
      ) {
        this.#sesion = null;
        const otra = await this.#idSesion();
        return this.#pedir(method, `/session/${otra}${sub}`, body);
      }
      throw err;
    }
  }

  /** Captura PNG de la pantalla (no hace falta sesión). */
  async pantalla(): Promise<Buffer> {
    const d = (await this.#pedir('GET', '/screenshot')) as { value?: string } | null;
    if (typeof d?.value !== 'string' || !d.value)
      throw new WdaError('WebDriverAgent no ha dado la pantalla.', 'no-enviado');
    return Buffer.from(d.value, 'base64');
  }

  /**
   * Lo que hay en pantalla, una línea por elemento con texto y su centro en puntos
   * (src/iphone/wda-texto.ts). Si WDA no da el JSON o no trae nada reconocible, el árbol
   * en texto de siempre (`leerCrudo`).
   */
  async leer(): Promise<string> {
    try {
      const d = (await this.#pedir('GET', '/source?format=json')) as { value?: unknown } | null;
      const resumen = resumirArbolWda(d?.value);
      if (resumen) return resumen;
    } catch (err) {
      // Sin conexión no hay nada que reintentar con el otro formato.
      if (err instanceof WdaError && err.entrega === 'no-enviado') throw err;
    }
    return this.leerCrudo();
  }

  /** Árbol de accesibilidad entero, en el texto de XCTest (largo: se recorta en la tool). */
  async leerCrudo(): Promise<string> {
    const d = (await this.#pedir('GET', '/source?format=description')) as { value?: string } | null;
    return typeof d?.value === 'string' ? d.value : '';
  }

  async tocar(x: number, y: number): Promise<void> {
    await this.#enSesion('POST', '/wda/tap', { x, y });
  }

  async escribir(texto: string): Promise<void> {
    await this.#enSesion('POST', '/wda/keys', { value: [...texto] });
  }

  async abrir(bundleId: string): Promise<void> {
    await this.#enSesion('POST', '/wda/apps/launch', { bundleId });
  }

  async inicio(): Promise<void> {
    await this.#pedir('POST', '/wda/homescreen');
  }
}

/** `/iphone diagnostico`: qué está listo y qué falta, en castellano. */
export async function diagnosticoWda(
  env: NodeJS.ProcessEnv,
  cliente: Pick<WdaClient, 'estado' | 'pantalla'>,
): Promise<string> {
  const lineas: string[] = ['📱 Diagnóstico del iPhone (WebDriverAgent, experimental)'];
  if (!wdaActivo(env)) {
    lineas.push(
      '• Apagado: falta PA_IPHONE_WDA=1 en .env. Es opcional; la guía está en docs/iphone-wda.md.',
    );
    return lineas.join('\n');
  }
  const url = wdaUrl(env);
  lineas.push(`• Activado. Busco WebDriverAgent en ${url}`);
  try {
    const e = await cliente.estado();
    lineas.push(
      `• WebDriverAgent contesta${e.ios ? ` (iOS ${e.ios})` : ''}${e.dispositivo ? `, ${e.dispositivo}` : ''}${e.listo ? '' : ', pero dice que no está listo'}.`,
    );
  } catch (err) {
    lineas.push(`• ❌ ${err instanceof Error ? err.message : String(err)}`);
    lineas.push(
      '• Siguiente paso: en el PC, con el iPhone conectado y desbloqueado, arranca WebDriverAgent (docs/iphone-wda.md, paso 5) y vuelve a escribir /iphone diagnostico.',
    );
    return lineas.join('\n');
  }
  try {
    const png = await cliente.pantalla();
    lineas.push(`• Pantalla: ok (${Math.round(png.length / 1024)} KB).`);
    lineas.push('• Listo. Cada toque o texto que haga en el iPhone te lo preguntaré antes aquí.');
  } catch (err) {
    lineas.push(`• ❌ Pantalla: ${err instanceof Error ? err.message : String(err)}`);
  }
  return lineas.join('\n');
}

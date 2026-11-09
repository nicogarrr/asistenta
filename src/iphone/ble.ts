/**
 * Manos del iPhone por Bluetooth LE desde el PC con Windows, sin la ESP32.
 *
 * El PC se presenta al iPhone como teclado + ratón + puntero absoluto por HID sobre GATT
 * (HOGP). La parte de radio la hace un ayudante propio y pequeño
 * (deploy/iphone/windows/AsistentaHid.cs, compilado con el csc que ya trae Windows) que
 * publica el servicio con el GattServiceProvider de WinRT y reproduce las secuencias de
 * informes con su propio reloj (un informe cada 8 ms en los arrastres). Aquí solo se
 * decide QUÉ se manda (src/iphone/hid-informes.ts) y se habla con él por stdin/stdout,
 * una línea JSON por mensaje.
 *
 * Idea de abhishek-raj/windows-ble-hid (BleHid, MIT): HOGP con el GattServiceProvider de
 * Windows. No se ha copiado su código ni se instala su app. Ver THIRD_PARTY_NOTICES.md.
 *
 * Detrás de PA_IPHONE_BLE=1 (apagado por defecto). Sin probar con un iPhone real.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { log } from '../log.js';
import type { ManosIphone } from './gestos.js';
import {
  MAPA_INFORMES,
  type PasoHid,
  type PuntosPantalla,
  secuenciaArrastre,
  secuenciaCombo,
  secuenciaTexto,
  secuenciaToque,
  soltarTodo,
} from './hid-informes.js';

/** ¿Manos por Bluetooth desde el PC? Solo con `PA_IPHONE_BLE=1` (por defecto, no). */
export function bleActivado(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_IPHONE_BLE ?? '').trim() === '1';
}

/** Lo que el ayudante dice de la radio y del iPhone. */
export interface EstadoBle {
  /** El adaptador puede hacer de periférico LE (si no, no hay nada que hacer). */
  periferico: boolean;
  /** El servicio HID se está anunciando. */
  anunciando: boolean;
  /** Algún central (el iPhone) está suscrito al puntero absoluto. */
  conectado: boolean;
  /** Motivo legible si algo no va. */
  problema?: string;
}

/** Hablar con el ayudante: una petición, su respuesta. */
export interface CanalHid {
  pedir(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export class BleError extends Error {}

/** Qué falta para dar pasos por Bluetooth. Vacío = listo. */
export function faltanBle(e: EstadoBle): string[] {
  if (!e.periferico) {
    return [
      e.problema ??
        'el Bluetooth de este PC no puede hacer de periférico LE (rol «peripheral»): con este adaptador no se puede; hace falta otro (p. ej. un USB 5.0 que nombre su chip)',
    ];
  }
  const f: string[] = [];
  if (!e.anunciando) f.push(e.problema ?? 'el ayudante Bluetooth no está anunciando el teclado');
  if (!e.conectado)
    f.push(
      'el iPhone no está conectado al PC por Bluetooth (Ajustes > Bluetooth > el nombre de este PC; AssistiveTouch activado)',
    );
  return f;
}

/** Cuánto tarda en reproducirse una secuencia (para el tope de espera de la respuesta). */
export function duracionMs(pasos: readonly PasoHid[]): number {
  return pasos.reduce((a, p) => a + p.ms, 0);
}

/** Las manos del iPhone sobre el ayudante BLE. x e y en fracciones (0 a 1). */
export class ManosBle implements ManosIphone {
  private readonly canal: CanalHid;
  private readonly pantalla: PuntosPantalla | undefined;

  constructor(canal: CanalHid, pantalla?: PuntosPantalla) {
    this.canal = canal;
    this.pantalla = pantalla;
  }

  private async enviar(pasos: PasoHid[]): Promise<void> {
    const r = await this.canal.pedir(
      {
        op: 'enviar',
        pasos: pasos.map((p) => ({ r: p.r, d: Buffer.from(p.d).toString('base64'), ms: p.ms })),
      },
      5_000 + duracionMs(pasos),
    );
    if (r.ok !== true) {
      const enviados = typeof r.enviados === 'number' ? r.enviados : 0;
      throw new BleError(
        `El ayudante Bluetooth no pudo mandarlo todo (${enviados} de ${pasos.length} informes): ${String(r.error ?? 'sin motivo')}.`,
      );
    }
  }

  async estado(): Promise<EstadoBle> {
    const r = await this.canal.pedir({ op: 'estado' });
    return {
      periferico: r.periferico === true,
      anunciando: r.anunciando === true,
      conectado: r.conectado === true,
      ...(typeof r.problema === 'string' && r.problema ? { problema: r.problema } : {}),
    };
  }

  async tap(x: number, y: number): Promise<void> {
    await this.enviar(secuenciaToque(x, y));
  }

  async swipe(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await this.enviar(secuenciaArrastre(x1, y1, x2, y2, this.pantalla));
  }

  async type(text: string): Promise<void> {
    await this.enviar(secuenciaTexto(text));
  }

  async key(combo: string): Promise<void> {
    await this.enviar(secuenciaCombo(combo));
  }

  /** Volver: arrastre desde el borde izquierdo, a media altura (receta de phoneuse). */
  async back(): Promise<void> {
    await this.enviar(secuenciaArrastre(0, 0.5, 0.6, 0.5, this.pantalla));
  }

  /** Parada: todo suelto (teclas y botón). */
  async soltar(): Promise<void> {
    await this.enviar(soltarTodo());
  }
}

/** Dónde está el ayudante compilado (lo deja ahí deploy/iphone/windows/compilar-hid.ps1). */
export function rutaAyudante(env: NodeJS.ProcessEnv = process.env): string {
  const propia = env.PA_IPHONE_BLE_AYUDANTE?.trim();
  if (propia) return propia;
  const base = env.LOCALAPPDATA?.trim() || join(env.USERPROFILE ?? '.', 'AppData', 'Local');
  return join(base, 'Asistenta', 'iphone', 'AsistentaHid.exe');
}

type Lanzar = () => ChildProcessWithoutNullStreams;

/**
 * El ayudante como proceso hijo, arrancado al primer uso y reutilizado. Si muere, la
 * siguiente petición lo vuelve a lanzar. Las respuestas van por `id`.
 */
export class ProcesoHid implements CanalHid {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private siguiente = 1;
  private readonly pendientes = new Map<
    number,
    { ok: (v: Record<string, unknown>) => void; mal: (e: Error) => void }
  >();
  private ultimoError = '';

  private readonly lanzar: Lanzar;
  private readonly plataforma: NodeJS.Platform;

  constructor(
    lanzar: Lanzar = () =>
      spawn(rutaAyudante(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
    plataforma: NodeJS.Platform = process.platform,
  ) {
    this.lanzar = lanzar;
    this.plataforma = plataforma;
  }

  private arrancar(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    if (this.plataforma !== 'win32') {
      throw new BleError('El iPhone por Bluetooth desde el PC solo funciona en Windows.');
    }
    let p: ChildProcessWithoutNullStreams;
    try {
      p = this.lanzar();
    } catch (err) {
      throw new BleError(
        `No pude arrancar el ayudante Bluetooth (${rutaAyudante()}): ${String(err)}. Compílalo con deploy/iphone/windows/compilar-hid.ps1.`,
      );
    }
    this.proc = p;
    // Lo primero que lee el ayudante: el mapa de informes que va a publicar.
    p.stdin.write(
      `${JSON.stringify({ op: 'mapa', d: Buffer.from(MAPA_INFORMES).toString('base64') })}\n`,
    );
    createInterface({ input: p.stdout }).on('line', (linea) => this.recibir(linea));
    createInterface({ input: p.stderr }).on('line', (linea) => {
      this.ultimoError = linea.slice(0, 300);
    });
    const caido = (motivo: string) => {
      if (this.proc !== p) return;
      this.proc = null;
      const e = new BleError(
        `El ayudante Bluetooth se ha cerrado (${motivo})${this.ultimoError ? `: ${this.ultimoError}` : ''}.`,
      );
      for (const { mal } of this.pendientes.values()) mal(e);
      this.pendientes.clear();
    };
    p.on('error', (err) => caido(String(err)));
    p.on('exit', (code) => caido(`código ${code}`));
    return p;
  }

  private recibir(linea: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(linea) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') {
      if (msg.evento) log.info('iphone ble', { evento: msg.evento, detalle: msg.mensaje });
      return;
    }
    const p = this.pendientes.get(msg.id);
    if (!p) return;
    this.pendientes.delete(msg.id);
    p.ok(msg);
  }

  pedir(msg: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const p = this.arrancar();
    const id = this.siguiente++;
    return new Promise((ok, mal) => {
      const t = setTimeout(() => {
        this.pendientes.delete(id);
        mal(
          new BleError(
            `El ayudante Bluetooth no ha contestado en ${Math.round(timeoutMs / 1000)} s.`,
          ),
        );
      }, timeoutMs);
      this.pendientes.set(id, {
        ok: (v) => {
          clearTimeout(t);
          ok(v);
        },
        mal: (e) => {
          clearTimeout(t);
          mal(e);
        },
      });
      p.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
    });
  }

  cerrar(): void {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try {
      p.stdin.write('{"op":"salir"}\n');
      p.stdin.end();
    } catch {
      /* ya cerrado */
    }
    p.kill();
  }
}

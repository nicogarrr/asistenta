/**
 * Arranque del dictado con el daemon: solo si PA_DICTADO=1, solo en Windows y
 * solo en el PC del dueño (es una tecla local: nadie lo activa desde fuera).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.js';
import { ajustesDictado } from './ajustes.js';
import { transcribirLocal } from './prueba.js';
import { type DepsDictado, Dictado } from './sesion.js';

type Piezas = Omit<DepsDictado, 'transcribir' | 'log'>;

/**
 * Marcas para la bandeja de Windows (bandeja.ps1), en la carpeta de datos:
 * - `dictado.activo`: el dictado está encendido. Solo entonces la bandeja mira cada segundo
 *   si se está grabando; sin dictado (lo normal) no se despierta cada segundo para nada.
 * - `dictado.grabando`: se está grabando ahora (el punto se pone naranja).
 * Solo existen o no; dentro no hay nada.
 */
export const MARCA_ACTIVO = 'dictado.activo';
export const MARCA_GRABANDO = 'dictado.grabando';

function marcar(dir: string, nombre: string, si: boolean): void {
  const ruta = join(dir, nombre);
  try {
    if (si) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(ruta, '');
    } else rmSync(ruta, { force: true });
  } catch {
    // Una marca que no se puede escribir solo deja la bandeja sin el punto naranja.
  }
}

async function piezasWindows(tecla: number[][]): Promise<Piezas> {
  const w = await import('./windows.js');
  const { FfmpegMicCapture } = await import('../voice/wake.js');
  return {
    tecla: new w.TeclaWindows(tecla),
    capture: new FfmpegMicCapture(),
    escritor: w.escritorWindows(),
    avisar: (a) => w.avisarWindows(a),
  };
}

export interface OpcionesArranque {
  env?: NodeJS.ProcessEnv;
  plataforma?: NodeJS.Platform;
  log?: (linea: string) => void;
  piezas?: (tecla: number[][]) => Promise<Piezas>;
  transcribir?: DepsDictado['transcribir'];
  /** false con PA_DESKTOP=off: no se toca el teclado ni el micro. */
  escritorio?: boolean;
  /** Carpeta de las marcas para la bandeja (por defecto, la carpeta de datos). */
  dirMarcas?: string;
}

export async function arrancarDictado(o: OpcionesArranque = {}): Promise<Dictado | null> {
  const a = ajustesDictado(o.env ?? process.env);
  const log = o.log ?? (() => {});
  const dir = o.dirMarcas ?? paths.state;
  // Las de un arranque anterior (cierre brusco, o PA_DICTADO quitado) no valen.
  marcar(dir, MARCA_GRABANDO, false);
  marcar(dir, MARCA_ACTIVO, false);
  if (!a.activo) return null;
  if ((o.plataforma ?? process.platform) !== 'win32') {
    log('dictado: solo funciona en Windows');
    return null;
  }
  if (o.escritorio === false) {
    log('dictado: con PA_DESKTOP=off no escribo en tus apps');
    return null;
  }
  if (!a.tecla) {
    log(
      `dictado: no entiendo PA_DICTADO_TECLA «${a.teclaTexto.slice(0, 30)}»; usa por ejemplo ctrl+win`,
    );
    return null;
  }
  const piezas = await (o.piezas ?? piezasWindows)(a.tecla);
  const dictado = new Dictado({
    ...piezas,
    avisar: (aviso) => {
      marcar(dir, MARCA_GRABANDO, aviso === 'graba');
      piezas.avisar(aviso);
    },
    transcribir: o.transcribir ?? transcribirLocal,
    log,
    modo: a.modo,
  });
  await dictado.start();
  marcar(dir, MARCA_ACTIVO, true);
  const parar = dictado.stop.bind(dictado);
  // Síncrono y lo primero: al salir (process 'exit') no da tiempo a nada asíncrono.
  dictado.stop = async () => {
    marcar(dir, MARCA_GRABANDO, false);
    marcar(dir, MARCA_ACTIVO, false);
    await parar();
  };
  log(`dictado: listo, mantén ${a.teclaTexto} y habla`);
  return dictado;
}

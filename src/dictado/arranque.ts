/**
 * Arranque del dictado con el daemon: solo si PA_DICTADO=1, solo en Windows y
 * solo en el PC del dueño (es una tecla local: nadie lo activa desde fuera).
 */

import { ajustesDictado } from './ajustes.js';
import { transcribirLocal } from './prueba.js';
import { type DepsDictado, Dictado } from './sesion.js';

type Piezas = Omit<DepsDictado, 'transcribir' | 'log'>;

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
}

export async function arrancarDictado(o: OpcionesArranque = {}): Promise<Dictado | null> {
  const a = ajustesDictado(o.env ?? process.env);
  const log = o.log ?? (() => {});
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
    transcribir: o.transcribir ?? transcribirLocal,
    log,
    modo: a.modo,
  });
  await dictado.start();
  log(`dictado: listo, mantén ${a.teclaTexto} y habla`);
  return dictado;
}

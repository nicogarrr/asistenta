/**
 * Dictado por voz en cualquier app: mientras se mantiene la tecla se graba del
 * micrófono; al soltarla se pasa a texto con la voz local, se limpia y se
 * escribe en la app que tenga el foco. No guarda audio ni texto.
 *
 * Nunca escribe en un campo de contraseña: se mira al pulsar (ni se graba) y
 * otra vez justo antes de escribir, por si el foco cambió mientras hablaba.
 */

import { looksSilent } from '../voice/audio.js';
import type { WakeCapture } from '../voice/wake.js';
import { limpiarDictado } from './limpiar.js';
import { unirTrozos } from './prueba.js';
import type { Aviso, EscritorDictado, TeclaDictado } from './tipos.js';

export interface DepsDictado {
  tecla: TeclaDictado;
  capture: WakeCapture;
  transcribir: (pcm: Float32Array) => Promise<string>;
  escritor: EscritorDictado;
  avisar: (a: Aviso) => void;
  /** Línea para el registro: nunca lleva lo dictado. */
  log?: (linea: string) => void;
  maxSegundos?: number;
  /** Por defecto mantener. */
  modo?: 'mantener' | 'alternar';
  temporizador?: (ms: number, fn: () => void) => () => void;
}

type Estado = 'quieto' | 'grabando' | 'procesando';

function temporizar(ms: number, fn: () => void): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

export class Dictado {
  #d: DepsDictado;
  #estado: Estado = 'quieto';
  #trozos: Float32Array[] = [];
  #cancelarTope: (() => void) | null = null;
  /** Lo que se está procesando ahora (para los tests y para parar limpio). */
  enCurso: Promise<void> = Promise.resolve();

  constructor(deps: DepsDictado) {
    this.#d = deps;
  }

  get estado(): Estado {
    return this.#estado;
  }

  async start(): Promise<void> {
    const alternar = this.#d.modo === 'alternar';
    await this.#d.tecla.start(
      () => {
        if (alternar && this.#estado === 'grabando')
          this.enCurso = this.enCurso.then(() => this.#soltar());
        else this.enCurso = this.#pulsar();
      },
      () => {
        if (!alternar) this.enCurso = this.enCurso.then(() => this.#soltar());
      },
      () => {
        this.enCurso = this.enCurso.then(() => this.#descartar());
      },
    );
  }

  async stop(): Promise<void> {
    await this.#d.tecla.stop();
    if (this.#estado === 'grabando') await this.#d.capture.stop().catch(() => {});
    this.#cancelarTope?.();
    this.#estado = 'quieto';
  }

  #log(l: string): void {
    this.#d.log?.(l);
  }
  async #pulsar(): Promise<void> {
    if (this.#estado !== 'quieto') return;
    this.#estado = 'grabando';
    if (await this.#d.escritor.campoSeguro().catch(() => false)) {
      this.#estado = 'quieto';
      this.#d.avisar('no');
      this.#log('dictado: campo de contraseña, no grabo');
      return;
    }
    this.#trozos = [];
    try {
      await this.#d.capture.start(
        (pcm) => this.#trozos.push(pcm),
        (err) => this.#log(`dictado: el micrófono falló (${err.message})`),
      );
    } catch (err) {
      this.#estado = 'quieto';
      this.#d.avisar('no');
      this.#log(
        `dictado: no puedo usar el micrófono (${err instanceof Error ? err.message : err})`,
      );
      return;
    }
    this.#d.avisar('graba');
    const tope = (this.#d.maxSegundos ?? 120) * 1000;
    this.#cancelarTope = (this.#d.temporizador ?? temporizar)(tope, () => {
      if (this.#estado === 'grabando') {
        this.enCurso = this.enCurso.then(() => this.#soltar());
      }
    });
  }

  /** Esc mientras graba: se tira lo grabado, sin pasarlo a texto. */
  async #descartar(): Promise<void> {
    if (this.#estado !== 'grabando') return;
    this.#cancelarTope?.();
    this.#cancelarTope = null;
    this.#trozos = [];
    await this.#d.capture.stop().catch(() => {});
    this.#estado = 'quieto';
    this.#d.avisar('fin');
    this.#log('dictado: descartado con Esc');
  }

  async #soltar(): Promise<void> {
    if (this.#estado !== 'grabando') return;
    this.#estado = 'procesando';
    this.#cancelarTope?.();
    this.#cancelarTope = null;
    try {
      await this.#d.capture.stop().catch(() => {});
      this.#d.avisar('fin');
      const pcm = unirTrozos(this.#trozos);
      this.#trozos = [];
      if (pcm.length === 0 || looksSilent(pcm)) return;
      const texto = limpiarDictado(await this.#d.transcribir(pcm));
      if (!texto) return;
      if (await this.#d.escritor.campoSeguro().catch(() => false)) {
        this.#d.avisar('no');
        this.#log('dictado: el foco pasó a un campo de contraseña, no escribo');
        return;
      }
      await this.#d.escritor.escribir(texto);
      this.#log(`dictado: escritas ${Array.from(texto).length} letras`);
    } catch (err) {
      this.#d.avisar('no');
      this.#log(`dictado: no pude terminar (${err instanceof Error ? err.message : err})`);
    } finally {
      this.#estado = 'quieto';
    }
  }
}

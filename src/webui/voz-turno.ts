/**
 * Un turno de /voz de principio a fin, por etapas medidas: recibir el audio → oír
 * (whisper) → pensar (el agente) → voz (la del PC) → enviar al móvil.
 *
 * Tres reglas (Nico, 7 nov: «tarda muchísimo en contestarme al hablar e incluso ni me
 * contesta»):
 * - Nunca acaba callado: si una etapa falla o pasa su tope, la respuesta lleva el
 *   motivo por escrito y una frase hablada («Perdona, no te he oído bien…»). Si el PC no
 *   puede ponerle voz, el móvil la lee con la suya.
 * - Habla antes: cada frase que el agente termina de escribir se sintetiza ya, mientras
 *   sigue pensando el resto; en modo flujo (NDJSON) el móvil la recibe y la toca al
 *   momento, sin esperar a que acabe el turno.
 * - Cada etapa se mide y va al registro («voz movil: tiempos») y al móvil (`tiempos`).
 */
import { log } from '../log.js';
import { guardarResto, partirPrimeraFrase, respuestaRapida } from './voz-rapida.js';

export interface AudioPc {
  data: Buffer;
  mimeType: string;
}

export interface RespuestaChat extends Record<string, unknown> {
  text: string;
}

export interface VozTurnoDeps {
  transcribe(audio: Buffer, mime: string): Promise<string>;
  /** El turno del agente; `onDelta` recibe el texto según lo escribe (si el agente lo da). */
  chat(text: string, opts: { voz: true; onDelta: (delta: string) => void }): Promise<unknown>;
  speak?(text: string): Promise<AudioPc | null>;
  /** Tope de whisper (por defecto 30 s). */
  topeOirMs?: number;
  /** Tope del agente antes de contestar «sigo pensando» (por defecto 45 s, < 60 s del móvil). */
  topePensarMs?: number;
  ahora?: () => number;
}

export interface TiemposVoz {
  recibirMs: number;
  oirMs: number;
  pensarMs: number;
  /** Desde que llegó el audio hasta la primera frase con voz lista. */
  primeraVozMs: number;
  /** Tiempo total sintetizando (suma de todas las frases). */
  vozMs: number;
  totalMs: number;
  rapida: boolean;
}

export type FalloVoz = 'oir' | 'pensar' | 'tarde';

export interface FraseVoz {
  n: number;
  texto: string;
  audio?: { mime: string; data: string };
}

export type EventoVoz =
  | { tipo: 'estado'; estado: 'oyendo' | 'pensando' | 'hablando' }
  | { tipo: 'oido'; oido: string }
  | ({ tipo: 'frase' } & FraseVoz)
  | {
      tipo: 'fin';
      oido: string;
      text: string;
      tiempos: TiemposVoz;
      fallo?: FalloVoz;
      /** Respuesta que aún se está pensando: el móvil la pide en /api/voz/resto. */
      pendiente?: string;
      respuesta?: RespuestaChat;
    };

export const PERDONA_OIR = 'Perdona, no te he oído bien.';
export const PERDONA_PENSAR = 'Perdona, algo ha fallado al pensar la respuesta. Prueba otra vez.';
export const SIGO_PENSANDO = 'Sigo pensándolo; te lo digo en cuanto lo tenga.';
/** Por voz no se lee un informe: pasado esto, el resto se queda escrito. */
const MAX_HABLADO = 700;
const RESTO_ESCRITO = 'El resto te lo dejo escrito.';

/**
 * Lo que llega al agente desde /voz: marcado como hablado (una palabra mal oída no es
 * algo que Nico escribió) y con la forma de la respuesta, que se va a decir en voz alta:
 * corta, sin listas ni enlaces. Si pide detalle, el agente puede alargarse.
 */
export function vozPanelPrompt(oido: string): string {
  return `[Por voz desde /voz, transcrito: contesta en 1 a 3 frases cortas y naturales para decirlas en voz alta, sin listas, tablas, enlaces ni emojis, salvo que pida detalle] ${oido}`;
}

/** Tope para una promesa: `null` si no llega a tiempo (la promesa sigue viva). */
function conTope<T>(p: Promise<T>, ms: number): Promise<{ ok: T } | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), Math.max(0, ms));
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve({ ok: v });
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Corta en frases el texto según llega: una frase sale cuando termina en . ! ? … o salto
 * de línea seguido de espacio (así «3.5» no se corta). La primera vale corta («Vale.»),
 * las demás se juntan hasta ~40 caracteres para no hacer muchas síntesis pequeñas.
 */
export class CortadorFrases {
  #buf = '';
  #salidas = 0;
  readonly minPrimera: number;
  readonly minResto: number;
  readonly max: number;
  constructor(minPrimera = 12, minResto = 40, max = 220) {
    this.minPrimera = minPrimera;
    this.minResto = minResto;
    this.max = max;
  }

  /** Añade texto y devuelve las frases ya terminadas. */
  push(delta: string): string[] {
    this.#buf += delta;
    const out: string[] = [];
    for (;;) {
      const min = this.#salidas === 0 ? this.minPrimera : this.minResto;
      const re = /[.!?…\n](?=\s)/g;
      let corte = -1;
      for (let m = re.exec(this.#buf); m; m = re.exec(this.#buf)) {
        if (this.#buf.slice(0, m.index + 1).trim().length >= min) {
          corte = m.index + 1;
          break;
        }
      }
      if (corte < 0 && this.#buf.length > this.max) {
        corte = this.#buf.lastIndexOf(' ', this.max);
        if (corte <= 0) corte = this.max;
      }
      if (corte < 0) return out;
      const frase = this.#buf.slice(0, corte).trim();
      this.#buf = this.#buf.slice(corte);
      if (frase) {
        out.push(frase);
        this.#salidas++;
      }
    }
  }
}

/** Lo que falta por decir del texto final, quitando las frases que ya sonaron en orden. */
export function restoPorDecir(final: string, dichas: readonly string[]): string {
  let pos = 0;
  for (const frase of dichas) {
    while (pos < final.length && /\s/.test(final[pos] ?? '')) pos++;
    if (!final.startsWith(frase, pos)) break;
    pos += frase.length;
  }
  return final.slice(pos).trim();
}

/** El resto en trozos de frase (como mucho `max` caracteres por trozo). */
function trocear(texto: string): string[] {
  const out: string[] = [];
  let resto = texto.trim();
  while (resto) {
    const [a, b] = partirPrimeraFrase(resto, 40, 220);
    if (!a) break;
    out.push(a);
    resto = b;
  }
  return out;
}

function motivoDe(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err ?? '');
}

/**
 * Corre un turno de /voz y va contando lo que pasa por `emit`. `modo: 'json'` junta la
 * respuesta como antes (primera frase con audio + `audioResto`); `'flujo'` manda cada
 * frase en cuanto tiene voz.
 */
export async function turnoVoz(
  audio: Buffer,
  mime: string,
  deps: VozTurnoDeps,
  emit: (e: EventoVoz) => void,
  medidas: { inicio: number; recibirMs: number },
  modo: 'flujo' | 'json' = 'flujo',
): Promise<void> {
  const ahora = deps.ahora ?? Date.now;
  const tiempos: TiemposVoz = {
    recibirMs: medidas.recibirMs,
    oirMs: 0,
    pensarMs: 0,
    primeraVozMs: 0,
    vozMs: 0,
    totalMs: 0,
    rapida: false,
  };
  let n = 0;
  let hablado = 0;
  let cola: Promise<void> = Promise.resolve();
  let cerrado = false;
  const dichas: string[] = [];

  const sintetizar = async (texto: string): Promise<FraseVoz['audio']> => {
    if (!deps.speak) return undefined;
    const t0 = ahora();
    try {
      const v = await deps.speak(texto);
      return v && v.data.length > 0
        ? { mime: v.mimeType, data: v.data.toString('base64') }
        : undefined;
    } catch (err) {
      log.warn('voz movil: sin audio del PC para una frase', { err: motivoDe(err) });
      return undefined;
    } finally {
      tiempos.vozMs += ahora() - t0;
    }
  };

  /** En cola (de una en una: con 4 núcleos, dos síntesis a la vez tardan más que en fila). */
  const decir = (texto: string): void => {
    if (cerrado || !texto.trim() || hablado >= MAX_HABLADO) return;
    let t = texto.trim();
    hablado += t.length;
    if (hablado >= MAX_HABLADO) t = `${t} ${RESTO_ESCRITO}`;
    dichas.push(texto.trim());
    const i = n++;
    cola = cola.then(async () => {
      const a = await sintetizar(t);
      if (i === 0) {
        tiempos.primeraVozMs = ahora() - medidas.inicio;
        emit({ tipo: 'estado', estado: 'hablando' });
      }
      emit({ tipo: 'frase', n: i, texto: t, ...(a ? { audio: a } : {}) });
    });
  };

  const terminar = async (
    oido: string,
    text: string,
    extra: { fallo?: FalloVoz; pendiente?: string; respuesta?: RespuestaChat } = {},
  ): Promise<void> => {
    await cola;
    cerrado = true;
    tiempos.totalMs = ahora() - medidas.inicio;
    if (extra.fallo) log.warn('voz movil: tiempos', { ...tiempos, fallo: extra.fallo });
    else log.info('voz movil: tiempos', { ...tiempos });
    emit({ tipo: 'fin', oido, text, tiempos: { ...tiempos }, ...extra });
  };

  emit({ tipo: 'estado', estado: 'oyendo' });
  // 1) Oír.
  const tOir = ahora();
  let oido = '';
  try {
    const r = await conTope(deps.transcribe(audio, mime), deps.topeOirMs ?? 30_000);
    if (r === null) {
      throw new Error(
        'el reconocimiento de voz aún se está cargando (la primera vez tarda); pulsa «Reintentar» en un momento',
      );
    }
    oido = r.ok.trim();
  } catch (err) {
    tiempos.oirMs = ahora() - tOir;
    // El whisper local explica en castellano qué pasó (silencio, formato, ffmpeg…).
    const motivo = motivoDe(err) || 'no he podido leer el audio';
    decir(PERDONA_OIR);
    await terminar('', `Perdona, no te he oído bien: ${motivo}. Prueba otra vez.`, {
      fallo: 'oir',
    });
    return;
  }
  tiempos.oirMs = ahora() - tOir;
  if (!oido) {
    const t = 'No te he entendido. Prueba otra vez, más cerca del micro.';
    decir(t);
    await terminar('', t, { fallo: 'oir' });
    return;
  }
  emit({ tipo: 'oido', oido });
  emit({ tipo: 'estado', estado: 'pensando' });

  // 2) Pensar (y, en flujo, hablar a la vez).
  const rapida = respuestaRapida(oido);
  tiempos.rapida = rapida !== null;
  const tPensar = ahora();
  const cortador = new CortadorFrases();
  const onDelta = (d: string): void => {
    if (modo !== 'flujo' || cerrado) return;
    for (const frase of cortador.push(d)) decir(frase);
  };
  const enMarcha: Promise<unknown> = rapida
    ? Promise.resolve({ text: rapida })
    : Promise.resolve().then(() => deps.chat(oido, { voz: true, onDelta }));
  let answer: RespuestaChat;
  try {
    const r = await conTope(enMarcha, deps.topePensarMs ?? 45_000);
    if (r === null) {
      tiempos.pensarMs = ahora() - tPensar;
      // Ni callada ni perdida: la respuesta queda en marcha y el móvil la pide luego.
      const pendiente = guardarResto(
        enMarcha.then(
          async (a) => {
            const text = validar(a).text;
            const falta = restoPorDecir(text, dichas).slice(0, MAX_HABLADO);
            const audio = falta ? await sintetizar(falta) : undefined;
            return { text, decir: falta, ...(audio ? { audio } : {}) };
          },
          () => ({ text: PERDONA_PENSAR }),
        ),
        10 * 60_000,
      );
      decir(SIGO_PENSANDO);
      await terminar(oido, SIGO_PENSANDO, { fallo: 'tarde', pendiente });
      return;
    }
    answer = validar(r.ok);
  } catch (err) {
    tiempos.pensarMs = ahora() - tPensar;
    log.warn('voz movil: el agente falló', { err: motivoDe(err) });
    decir(PERDONA_PENSAR);
    await terminar(oido, `${PERDONA_PENSAR} Pulsa «Reintentar».`, { fallo: 'pensar' });
    return;
  }
  tiempos.pensarMs = ahora() - tPensar;

  // 3) Lo que falta por decir.
  const text = answer.text.trim()
    ? answer.text
    : 'Perdona, no me ha salido ninguna respuesta. Prueba otra vez.';
  const falta = restoPorDecir(text, dichas);
  if (modo === 'flujo') {
    for (const frase of trocear(falta)) decir(frase);
  } else if (falta) {
    const [primera, resto] = partirPrimeraFrase(falta);
    decir(primera);
    if (resto && deps.speak) {
      const speak = deps.speak;
      answer = {
        ...answer,
        // Detrás de la primera (en fila: no le quita CPU a la que va a sonar ya).
        audioResto: guardarResto(
          cola
            .then(() => speak(resto))
            .then((v) =>
              v && v.data.length > 0 ? { mime: v.mimeType, data: v.data.toString('base64') } : null,
            )
            .catch(() => null),
        ),
      };
    }
  }
  await terminar(oido, text, { respuesta: { ...answer, text } });
}

function validar(a: unknown): RespuestaChat {
  if (typeof a !== 'object' || a === null || typeof (a as { text?: unknown }).text !== 'string') {
    throw new Error('deps.chat devolvio una respuesta invalida');
  }
  return a as RespuestaChat;
}

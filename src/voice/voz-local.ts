/**
 * Voz local nueva que se instala sola: sherpa-onnx (sherpa.ts) con una voz Piper en
 * ONNX descargada de la release oficial de sherpa-onnx, con URL y SHA-256 fijados
 * aquí. Medido en voz-tts1 (15 frases, faster-whisper como juez): la voz castellana
 * «sharvard» se entiende mejor que Piper davefx (6,2 % de palabras mal frente a 9,0 %),
 * no satura y empieza a sonar en ~0,1 s en vez de ~0,3 s.
 *
 * Nunca bloquea: mientras el modelo no está (primer arranque, tras una actualización
 * que cambia el modelo fijado, sin red) se habla con la voz de siempre (SAPI/Piper,
 * piper.ts) y la descarga sigue en segundo plano. La descarga se reanuda donde se
 * quedó, se comprueba el SHA-256 antes de usar nada y se coloca con un rename, así que
 * un corte nunca deja un modelo a medias. Sin red, se reintenta pasados 10 minutos.
 *
 * `PA_TTS_LOCAL`: supertonic-f2 (por defecto; Supertonic 3, voz F2) | supertonic (F3) |
 * supertonic-f5 | kokoro | kokoro-alex | kokoro-santa | sharvard | davefx | off (ni se
 * descarga ni se usa). Las dos son voces castellanas (es_ES). `PA_TTS=piper` o `PA_TTS=sapi` también la
 * apagan. En Windows va encendida por defecto; en otros sistemas solo si se pone
 * `PA_TTS_LOCAL`.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { childEnv } from '../child-env.js';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { createSherpaTts, type ModeloSherpa } from './sherpa.js';
import type { Tts, TtsAudio, TtsSpeakOptions } from './tts.js';

export interface VozLocal {
  /** Valor de PA_TTS_LOCAL. */
  clave: string;
  /** Carpeta raíz dentro del archivo (el nombre del .tar.bz2 sin extensión). */
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  onnx: string;
  /** Hablante dentro del modelo (sharvard trae dos: 0 = hombre, 1 = mujer). */
  sid: number;
  /** Kokoro (multivoz) o Supertonic 3 (la más natural) en vez de VITS/Piper. */
  motor?: 'kokoro' | 'supertonic';
}

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';

/**
 * Kokoro-82M (Apache-2.0) en la release oficial de sherpa-onnx: suena mucho más natural
 * que Piper (entonación de persona, no de GPS) y en CPU va de sobra: en voz2 una frase
 * de 6 s salió en ~1 s con 4 hilos y faster-whisper la transcribió sin un fallo. Pesa
 * 350 MB (se baja una vez). Castellano con fonemas de espeak-ng «es».
 */
const KOKORO = {
  id: 'kokoro-multi-lang-v1_0',
  url: `${RELEASE}/kokoro-multi-lang-v1_0.tar.bz2`,
  sha256: '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4',
  bytes: 349_886_476,
  onnx: 'model.onnx',
  motor: 'kokoro',
} as const;

/**
 * Supertonic 3 (Supertone, OpenRAIL-M), int8 de la release de sherpa-onnx: 31 idiomas,
 * castellano incluido, a 44,1 kHz. En voz5 (4 hilos, CPU) cada oración salió en 0,6-0,9 s
 * con ~300 MB de RAM, tan rápida como Kokoro y más natural. Pesa 129 MB. Sus 10 voces van
 * por orden F1-F5 y M1-M5 (sid 0-9).
 */
const SUPERTONIC = {
  id: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
  url: `${RELEASE}/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`,
  sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427',
  bytes: 128_774_318,
  onnx: 'vector_estimator.int8.onnx',
  motor: 'supertonic',
} as const;

/** Modelos fijados (release oficial «tts-models» de k2-fsa/sherpa-onnx). */
export const VOCES_LOCALES: Readonly<Record<string, VozLocal>> = {
  // ef_dora (mujer), em_alex (hombre), em_santa (hombre).
  kokoro: { clave: 'kokoro', ...KOKORO, sid: 28 },
  'kokoro-alex': { clave: 'kokoro-alex', ...KOKORO, sid: 29 },
  'kokoro-santa': { clave: 'kokoro-santa', ...KOKORO, sid: 53 },
  // voice.bin va F1..F5 y luego M1..M5: F2 = sid 1 (la que eligió Nico), F3 = 2, F5 = 4.
  'supertonic-f2': { clave: 'supertonic-f2', ...SUPERTONIC, sid: 1 },
  supertonic: { clave: 'supertonic', ...SUPERTONIC, sid: 2 },
  'supertonic-f5': { clave: 'supertonic-f5', ...SUPERTONIC, sid: 4 },
  sharvard: {
    clave: 'sharvard',
    id: 'vits-piper-es_ES-sharvard-medium',
    url: `${RELEASE}/vits-piper-es_ES-sharvard-medium.tar.bz2`,
    sha256: 'b30a7a83df0518f0ee1c7039506648cade99f1f9b498fc49ed2ced2e2536bb5a',
    bytes: 80_318_184,
    onnx: 'es_ES-sharvard-medium.onnx',
    sid: 0,
  },
  davefx: {
    clave: 'davefx',
    id: 'vits-piper-es_ES-davefx-medium',
    url: `${RELEASE}/vits-piper-es_ES-davefx-medium.tar.bz2`,
    sha256: 'a3f6beb54a9cb893279f72978a22f807a4d9fc9c7848157b524d5cc7b7f58b22',
    bytes: 67_184_952,
    onnx: 'es_ES-davefx-medium.onnx',
    sid: 0,
  },
};

/** Supertonic 3 F2 (Nico, 6 nov): mientras se descarga, o si falla, habla Kokoro. */
export const VOZ_LOCAL_POR_DEFECTO = 'supertonic-f2';

/** Mientras Kokoro se descarga, si ya está la voz anterior (sharvard), habla esa. */
export const VOZ_LOCAL_PUENTE = 'sharvard';

/**
 * La voz que habla mientras la elegida se descarga o si falla: Supertonic tira de Kokoro
 * (la que ya tiene el PC desde #2195); las demás, de sharvard. null si es ella misma.
 */
export function vozPuente(voz: VozLocal): VozLocal | null {
  const clave = voz.motor === 'supertonic' ? 'kokoro' : VOZ_LOCAL_PUENTE;
  if (voz.clave === clave) return null;
  return VOCES_LOCALES[clave] ?? null;
}

/** Tras un fallo de descarga (sin red, servidor caído) no se vuelve a probar antes. */
export const REINTENTO_DESCARGA_MS = 10 * 60_000;

const APAGADA = new Set(['off', '0', 'no', 'false']);

/** Qué voz local toca con esta configuración, o null si va apagada. */
export function vozLocalDesdeEnv(
  env: NodeJS.ProcessEnv = process.env,
  plataforma: NodeJS.Platform = process.platform,
): VozLocal | null {
  const motor = env.PA_TTS?.trim().toLowerCase();
  if (motor === 'piper' || motor === 'sapi') return null;
  const pedida = env.PA_TTS_LOCAL?.trim().toLowerCase();
  if (!pedida && plataforma !== 'win32') return null;
  if (pedida && APAGADA.has(pedida)) return null;
  return (
    VOCES_LOCALES[pedida || VOZ_LOCAL_POR_DEFECTO] ??
    (VOCES_LOCALES[VOZ_LOCAL_POR_DEFECTO] as VozLocal)
  );
}

/** La carpeta lleva el principio del SHA-256: cambiar el modelo fijado obliga a bajarlo. */
export function carpetaVozLocal(raiz: string, voz: VozLocal): string {
  return join(raiz, 'tts', `${voz.id}-${voz.sha256.slice(0, 12)}`);
}

export interface VozLocalLista extends ModeloSherpa {
  dir: string;
}

/** Lo que trae Supertonic 3 (sin espeak-ng: no usa fonemas). */
const ARCHIVOS_SUPERTONIC = {
  durationPredictor: 'duration_predictor.int8.onnx',
  textEncoder: 'text_encoder.int8.onnx',
  vectorEstimator: 'vector_estimator.int8.onnx',
  vocoder: 'vocoder.int8.onnx',
  ttsJson: 'tts.json',
  unicodeIndexer: 'unicode_indexer.bin',
  voiceStyle: 'voice.bin',
} as const;

/** Los ficheros que tiene que traer el archivo de la voz para darla por buena. */
function archivosDeVoz(voz: VozLocal): string[] {
  return voz.motor === 'supertonic'
    ? Object.values(ARCHIVOS_SUPERTONIC)
    : [voz.onnx, 'espeak-ng-data'];
}

/** El modelo ya descargado, comprobado y colocado, o null. */
export function vozLocalLista(raiz: string, voz: VozLocal): VozLocalLista | null {
  const dir = carpetaVozLocal(raiz, voz);
  try {
    if (readFileSync(join(dir, '.ok'), 'utf8').trim() !== voz.sha256) return null;
  } catch {
    return null;
  }
  if (voz.motor === 'supertonic') {
    const a = ARCHIVOS_SUPERTONIC;
    const supertonic = {
      durationPredictor: join(dir, a.durationPredictor),
      textEncoder: join(dir, a.textEncoder),
      vectorEstimator: join(dir, a.vectorEstimator),
      vocoder: join(dir, a.vocoder),
      ttsJson: join(dir, a.ttsJson),
      unicodeIndexer: join(dir, a.unicodeIndexer),
      voiceStyle: join(dir, a.voiceStyle),
    };
    if (!Object.values(supertonic).every((f) => existsSync(f))) return null;
    return { dir, onnx: supertonic.vectorEstimator, tokens: '', datos: '', supertonic };
  }
  const lista: VozLocalLista = {
    dir,
    onnx: join(dir, voz.onnx),
    tokens: join(dir, 'tokens.txt'),
    datos: join(dir, 'espeak-ng-data'),
  };
  if (voz.motor === 'kokoro') {
    lista.kokoro = {
      voces: join(dir, 'voices.bin'),
      lexicon: [join(dir, 'lexicon-us-en.txt'), join(dir, 'lexicon-zh.txt')].join(','),
      dict: join(dir, 'dict'),
    };
    if (!existsSync(lista.kokoro.voces)) return null;
  }
  return existsSync(lista.onnx) && existsSync(lista.tokens) && existsSync(lista.datos)
    ? lista
    : null;
}

export type Extraer = (archivo: string, destino: string) => Promise<void>;

/** tar de Windows (System32, trae bzip2 desde Windows 10) o el del sistema. */
function tarBin(): string {
  if (process.platform === 'win32') {
    const sistema = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(sistema)) return sistema;
  }
  return 'tar';
}

export const extraerConTar: Extraer = (archivo, destino) =>
  new Promise((resolve, reject) => {
    const child = spawn(tarBin(), ['-xjf', archivo, '-C', destino], {
      windowsHide: true,
      env: childEnv(),
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-1000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar salió con código ${code}`)),
    );
  });

export interface DescargaVozDeps {
  fetchImpl?: typeof fetch;
  extraer?: Extraer;
  /** Una línea de progreso para la consola. */
  progreso?: (linea: string) => void;
  timeoutMs?: number;
}

async function sha256Fichero(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

const mb = (n: number): number => Math.round(n / 1_000_000);

async function descargar(
  raiz: string,
  voz: VozLocal,
  deps: DescargaVozDeps,
): Promise<VozLocalLista> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const extraer = deps.extraer ?? extraerConTar;
  const progreso = deps.progreso ?? ((linea: string) => log.info(linea));
  const base = join(raiz, 'tts');
  mkdirSync(base, { recursive: true });
  const final = carpetaVozLocal(raiz, voz);
  const parcial = `${final}.tar.bz2.partial`;
  let tengo = existsSync(parcial) ? statSync(parcial).size : 0;
  if (tengo > voz.bytes) {
    rmSync(parcial, { force: true });
    tengo = 0;
  }
  if (tengo < voz.bytes) {
    progreso(
      tengo > 0
        ? `Voz local «${voz.clave}»: sigo la descarga (${mb(tengo)}/${mb(voz.bytes)} MB); mientras, hablo con la voz de siempre.`
        : `Voz local «${voz.clave}»: descargando ${mb(voz.bytes)} MB en segundo plano; mientras, hablo con la voz de siempre.`,
    );
    const res = await fetchImpl(voz.url, {
      headers: tengo > 0 ? { Range: `bytes=${tengo}-` } : {},
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30 * 60_000),
    });
    // 200 a una petición con Range: el servidor no reanuda y manda el fichero entero.
    if (res.status === 200) tengo = 0;
    else if (res.status !== 206)
      throw new Error(`la descarga de la voz local falló (HTTP ${res.status})`);
    if (!res.body) throw new Error('la descarga de la voz local llegó vacía');
    let llevo = tengo;
    let ultimoDecil = Math.floor((llevo / voz.bytes) * 10);
    const contador = new Transform({
      transform(chunk: Buffer, _enc, done) {
        llevo += chunk.length;
        const decil = Math.floor((llevo / voz.bytes) * 10);
        if (decil > ultimoDecil && decil < 10) {
          ultimoDecil = decil;
          progreso(`Voz local «${voz.clave}»: ${decil * 10} % (${mb(llevo)}/${mb(voz.bytes)} MB)`);
        }
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      contador,
      createWriteStream(parcial, { flags: tengo > 0 ? 'a' : 'w' }),
    );
  }
  const tam = statSync(parcial).size;
  const sha = await sha256Fichero(parcial);
  if (tam !== voz.bytes || sha !== voz.sha256) {
    rmSync(parcial, { force: true });
    throw new Error(
      `la voz local descargada no coincide con la fijada (sha256 ${sha.slice(0, 12)}, ${tam} B; se esperaba ${voz.sha256.slice(0, 12)}, ${voz.bytes} B): descartada`,
    );
  }
  const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  try {
    await extraer(parcial, tmp);
    const dentro = join(tmp, voz.id);
    // Supertonic no trae espeak-ng-data: antes se pedía a todas y Supertonic nunca
    // quedaba lista (se bajaba y descomprimía otra vez cada 10 min, y hablaba Kokoro).
    const falta = archivosDeVoz(voz).find((f) => !existsSync(join(dentro, f)));
    if (falta) {
      throw new Error(`el archivo de la voz local no trae el modelo esperado (falta ${falta})`);
    }
    writeFileSync(join(dentro, '.ok'), voz.sha256);
    rmSync(final, { recursive: true, force: true });
    renameSync(dentro, final);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  rmSync(parcial, { force: true });
  // Versiones anteriores de la misma voz (otro SHA fijado): ya no se usan.
  for (const nombre of readdirSync(base)) {
    if (
      nombre.startsWith(`${voz.id}-`) &&
      nombre !== basename(final) &&
      !nombre.endsWith('.partial')
    ) {
      rmSync(join(base, nombre), { recursive: true, force: true });
    }
  }
  const lista = vozLocalLista(raiz, voz);
  if (!lista) throw new Error('la voz local no quedó lista tras descargarla');
  progreso(`Voz local «${voz.clave}» lista: las próximas respuestas habladas la usan.`);
  return lista;
}

const enCurso = new Map<string, Promise<VozLocalLista>>();

/**
 * Devuelve el modelo listo, descargándolo si hace falta. Dos llamadas a la vez
 * comparten la misma descarga.
 */
export function asegurarVozLocal(
  raiz: string,
  voz: VozLocal,
  deps: DescargaVozDeps = {},
): Promise<VozLocalLista> {
  const lista = vozLocalLista(raiz, voz);
  if (lista) return Promise.resolve(lista);
  const clave = carpetaVozLocal(raiz, voz);
  let p = enCurso.get(clave);
  if (!p) {
    p = descargar(raiz, voz, deps).finally(() => enCurso.delete(clave));
    enCurso.set(clave, p);
  }
  return p;
}

export interface TtsConVozLocalDeps {
  /** La voz de siempre (createDefaultTts: SAPI y/o Piper). */
  respaldo: Tts;
  raiz?: string;
  plataforma?: NodeJS.Platform;
  descarga?: DescargaVozDeps;
  crearLocal?: (modelo: VozLocalLista, sid: number) => Tts;
  onFallback?: (err: unknown) => void;
  ahora?: () => number;
}

export type TtsConVozLocal = Tts & {
  /** Arranca la descarga si falta; true si la voz local queda lista. Nunca lanza. */
  precargar(): Promise<boolean>;
};

/** Fallos seguidos de la voz local (p. ej. el módulo nativo no carga) antes de dejarla hasta reiniciar. */
const FALLOS_PARA_DEJARLA = 3;

/**
 * Primero la voz local si está lista; si falta, se descarga en segundo plano y se
 * habla con `respaldo`; si falla, también `respaldo`.
 */
export function createTtsConVozLocal(
  env: NodeJS.ProcessEnv,
  deps: TtsConVozLocalDeps,
): TtsConVozLocal {
  const { respaldo } = deps;
  const voz = vozLocalDesdeEnv(env, deps.plataforma);
  if (!voz) {
    return {
      name: respaldo.name,
      speak: (text, opts) => respaldo.speak(text, opts),
      precargar: async () => false,
    };
  }
  const raiz = deps.raiz ?? paths.models;
  const ahora = deps.ahora ?? Date.now;
  const crearLocal =
    deps.crearLocal ?? ((modelo: VozLocalLista, sid: number) => createSherpaTts({ modelo, sid }));
  const puente = vozPuente(voz);
  let reintentarDesde = 0;
  let local: Tts | null = null;
  let localPuente: Tts | null = null;
  let fallos = 0;

  const precargar = async (): Promise<boolean> => {
    if (vozLocalLista(raiz, voz)) return true;
    if (ahora() < reintentarDesde) return false;
    try {
      await asegurarVozLocal(raiz, voz, deps.descarga);
      return true;
    } catch (err) {
      reintentarDesde = ahora() + REINTENTO_DESCARGA_MS;
      log.warn(
        'voz local: no se pudo descargar; sigo con la voz de siempre y reintento en 10 min',
        {
          err: err instanceof Error ? err.message : String(err),
        },
      );
      return false;
    }
  };

  /** La voz puente si ya está en el PC; null si no está o también falla. */
  const hablarPuente = async (text: string, opts: TtsSpeakOptions): Promise<TtsAudio | null> => {
    const listaPuente = puente ? vozLocalLista(raiz, puente) : null;
    if (!listaPuente || !puente) return null;
    localPuente ??= crearLocal(listaPuente, puente.sid);
    try {
      return await localPuente.speak(text, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      deps.onFallback?.(err);
      return null;
    }
  };

  return {
    name: `local+${respaldo.name}`,
    precargar,
    async speak(text: string, opts: TtsSpeakOptions = {}): Promise<TtsAudio> {
      const lista = vozLocalLista(raiz, voz);
      if (!lista) {
        void precargar();
        // Al cambiar de voz, mientras baja, la voz local anterior si ya estaba.
        return (await hablarPuente(text, opts)) ?? respaldo.speak(text, opts);
      }
      if (fallos < FALLOS_PARA_DEJARLA) {
        local ??= crearLocal(lista, voz.sid);
        try {
          const audio = await local.speak(text, opts);
          fallos = 0;
          return audio;
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          fallos++;
          deps.onFallback?.(err);
        }
      }
      // Supertonic que falla habla con Kokoro antes que con la voz del sistema.
      if (voz.motor === 'supertonic') {
        const audio = await hablarPuente(text, opts);
        if (audio) return audio;
      }
      return respaldo.speak(text, opts);
    },
  };
}

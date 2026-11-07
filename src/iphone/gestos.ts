/**
 * Recetas para el iPhone sobre los pasos sueltos del puente ESP32 (tocar, deslizar,
 * teclas): abrir una app, bajar o subir, escribir. Con PA_IPHONE_GESTOS=1, la tool
 * `iphone` deja al modelo principal de Asistenta manejar el teléfono paso a paso, leyendo
 * la pantalla en texto (src/iphone/texto.ts), en vez de mandar el objetivo entero al
 * agente aparte del servidor (que gasta su propia clave de visión).
 *
 * Ideas tomadas de phoneuse (github.com/lxe/phoneuse, MIT, © 2026 Aleksey Smolenchuk),
 * probadas allí en un iPhone 17 Pro con iOS 26 por Bluetooth, NO aquí con la ESP32 por
 * USB: abrir una app con Cmd+H, Cmd+Espacio, el nombre e Intro; bajar arrastrando el
 * contenido media pantalla; no escribir con el teléfono bloqueado; el teclado es de
 * EE. UU. El código es nuestro; no se ha copiado nada. Ver THIRD_PARTY_NOTICES.md.
 */
import { type LineaPantalla, pantallaBloqueada } from './texto.js';

/** Lo que el puente sabe hacer (IphoneClient): x e y en fracciones de la pantalla. */
export interface ManosIphone {
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
}

/** La pantalla en texto ahora mismo, o null si este equipo no puede leerla (sin OCR). */
export type OjosIphone = () => Promise<LineaPantalla[] | null>;

export class BloqueadoError extends Error {
  constructor() {
    super(
      'El iPhone está bloqueado (pantalla de bloqueo o de código). No escribo ni toco nada ahí: pide a Nico que lo desbloquee él.',
    );
  }
}

/** Tope de lo que se escribe de una vez. */
export const MAX_ESCRIBIR = 500;

/**
 * El firmware de la ESP32 escribe con un teclado de EE. UU. (`keyboard.print`): solo
 * ASCII imprimible. Una «ñ» o una tilde saldrían como basura, así que se rechazan antes
 * de mandar nada. Devuelve el motivo o null si se puede escribir.
 */
export function problemaAlEscribir(texto: string): string | null {
  if (!texto) return 'Falta el texto que escribir.';
  if (texto.length > MAX_ESCRIBIR) return `Como mucho ${MAX_ESCRIBIR} caracteres de una vez.`;
  const malos = [...new Set([...texto].filter((c) => c !== '\n' && !/[\x20-\x7e]/.test(c)))];
  if (malos.length) {
    return `El teclado del puente es de EE. UU. y no sabe escribir ${malos
      .slice(0, 5)
      .map((c) => `«${c}»`)
      .join(' ')}: escríbelo sin tildes ni eñes o pídele a Nico que lo escriba él.`;
  }
  return null;
}

/** Para buscar una app: sin tildes ni eñes («Música» → «Musica»; la búsqueda de iOS lo encuentra igual, sin comprobar). */
export function nombreTecleable(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TECLAS = 'enter|esc|tab|backspace|space|up|down|left|right|[a-z0-9]';
const COMBO = new RegExp(`^((cmd|ctrl|alt|shift)\\+){0,3}(${TECLAS})$`);

/** Una tecla o combinación que el firmware entiende: «enter», «cmd+a», «shift+tab»… */
export function comboValido(combo: string): boolean {
  return COMBO.test(combo.trim().toLowerCase());
}

export type Espera = (ms: number) => Promise<void>;

/** Con el teléfono bloqueado no se escribe; sin poder leer la pantalla, tampoco (no se puede comprobar). */
export async function exigeDesbloqueado(ojos: OjosIphone): Promise<void> {
  const lineas = await ojos();
  if (lineas === null) {
    throw new Error(
      'No puedo leer la pantalla del iPhone para comprobar que no está bloqueado, así que no escribo nada (hace falta el OCR de Windows).',
    );
  }
  if (pantallaBloqueada(lineas)) throw new BloqueadoError();
}

/** Escribe en el campo que tenga el foco; cada salto de línea es un Intro. */
export async function escribirTexto(
  manos: ManosIphone,
  ojos: OjosIphone,
  texto: string,
): Promise<void> {
  const mal = problemaAlEscribir(texto);
  if (mal) throw new Error(mal);
  await exigeDesbloqueado(ojos);
  const trozos = texto.split('\n');
  for (let i = 0; i < trozos.length; i++) {
    if (i > 0) await manos.key('enter');
    const t = trozos[i];
    if (t) await manos.type(t);
  }
}

/**
 * Abrir una app como lo haría una persona con teclado: Inicio (Cmd+H), buscar
 * (Cmd+Espacio), el nombre e Intro. Comprueba el bloqueo DESPUÉS de Cmd+H (que también
 * despierta la pantalla) y antes de escribir nada.
 */
export async function abrirApp(
  manos: ManosIphone,
  ojos: OjosIphone,
  nombre: string,
  espera: Espera,
): Promise<string> {
  const limpio = nombreTecleable(nombre);
  if (!limpio) throw new Error('Falta el nombre de la app (como sale en el iPhone).');
  if (limpio.length > 60) throw new Error('Ese nombre de app es demasiado largo.');
  await manos.key('cmd+h');
  await espera(700);
  await exigeDesbloqueado(ojos);
  await manos.key('cmd+space');
  await espera(600);
  await manos.type(limpio);
  await espera(900); // los resultados de la búsqueda llegan en tandas
  await manos.key('enter');
  return limpio;
}

/**
 * Bajar o subir arrastrando el contenido `medias` medias pantallas (0,5 a 2) por el centro.
 * Abajo = el dedo sube. Nunca empieza ni acaba en los bordes, que son gestos del sistema.
 */
export async function desplazar(
  manos: ManosIphone,
  direccion: 'abajo' | 'arriba',
  medias = 1,
): Promise<void> {
  const n = Math.min(Math.max(Number.isFinite(medias) ? medias : 1, 0.5), 2);
  const d = 0.4 * n;
  const [y0, y1] = direccion === 'arriba' ? [0.3, 0.3 + d] : [0.7, 0.7 - d];
  const tope = (v: number) => Math.round(Math.min(Math.max(v, 0.08), 0.92) * 1000) / 1000;
  await manos.swipe(0.5, tope(y0), 0.5, tope(y1));
}

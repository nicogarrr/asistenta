/**
 * /voz más rápida: lo que no necesita al agente no lo espera, y la voz empieza a sonar
 * con la primera frase mientras el PC sintetiza el resto.
 */
import { randomUUID } from 'node:crypto';

const SALUDO =
  /^(?:hola|holi|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|ey|qu[eé] tal|qu[eé] pasa|gracias|muchas gracias|vale gracias|ok gracias|adi[oó]s|hasta luego|chao|ciao)(?:\s+(?:asistenta|nico|guapa|t[ií]a|maja))?$/;

const RESPUESTAS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^(?:gracias|muchas gracias|vale gracias|ok gracias)/,
    '¡De nada! Aquí estoy si necesitas algo.',
  ],
  [/^(?:adi[oó]s|hasta luego|chao|ciao)/, '¡Hasta luego, Nico!'],
  [/^buenos d[ií]as/, '¡Buenos días, Nico! ¿Qué necesitas?'],
  [/^buenas tardes/, '¡Buenas tardes, Nico! ¿Qué necesitas?'],
  [/^buenas noches/, '¡Buenas noches, Nico! ¿Qué necesitas?'],
];

/**
 * Para un saludo o un «gracias» solo, la respuesta al momento sin pasar por el agente
 * (que tarda decenas de segundos en pensar «hola»). Cualquier otra cosa: null.
 */
export function respuestaRapida(oido: string): string | null {
  const t = oido
    .toLowerCase()
    .replace(/[¡!¿?.,;:…"«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || !SALUDO.test(t)) return null;
  for (const [re, frase] of RESPUESTAS) if (re.test(t)) return frase;
  return '¡Hola, Nico! Dime, ¿qué necesitas?';
}

/** Primera frase (al menos `minimo` caracteres) y el resto, para empezar a hablar antes. */
export function partirPrimeraFrase(texto: string, minimo = 40, maximo = 220): [string, string] {
  const t = texto.trim();
  if (t.length <= maximo) {
    const fin = buscarFin(t, minimo);
    if (fin < 0 || fin >= t.length - 1) return [t, ''];
    return [t.slice(0, fin + 1).trim(), t.slice(fin + 1).trim()];
  }
  let fin = buscarFin(t.slice(0, maximo), minimo);
  if (fin < 0) fin = t.lastIndexOf(' ', maximo);
  if (fin < 0) fin = maximo;
  return [t.slice(0, fin + 1).trim(), t.slice(fin + 1).trim()];
}

function buscarFin(t: string, minimo: number): number {
  const re = /[.!?…\n]/g;
  for (let m = re.exec(t); m; m = re.exec(t)) if (m.index + 1 >= minimo) return m.index;
  return -1;
}

export interface AudioVoz {
  mime: string;
  data: string;
}

const pendientes = new Map<string, Promise<unknown>>();
const CADUCA_MS = 2 * 60_000;

/**
 * Guarda algo en marcha (la síntesis del resto, o la respuesta que aún se piensa) y
 * devuelve con qué id pedirlo.
 */
export function guardarResto(audio: Promise<unknown>, caducaMs = CADUCA_MS): string {
  const id = randomUUID();
  pendientes.set(id, audio);
  setTimeout(() => pendientes.delete(id), caducaMs).unref?.();
  return id;
}

/** El resto (una sola vez); null si no existe o ya caducó. */
export async function tomarResto(id: string): Promise<unknown> {
  const p = pendientes.get(id);
  if (!p) return null;
  pendientes.delete(id);
  return p;
}

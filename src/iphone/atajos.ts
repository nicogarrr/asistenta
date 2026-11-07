/**
 * Atajos del iPhone, segunda tanda (Nico, 7 nov: «Todo» a las ideas 3–6).
 *
 * La puerta de texto (`POST /api/atajo`, src/webui/atajo.ts) ya existe; aquí van las
 * piezas puras de las otras rutas que usan el mismo token del panel:
 *
 * - `POST /api/atajo/lugar` `{ evento: 'llegar' | 'salir', sitio?: 'casa' }`: una
 *   automatización personal de iOS (al llegar o salir de casa) hace saltar los avisos
 *   de llegada sin compartir la ubicación en Telegram.
 * - `POST /api/atajo/resumen`: el resumen de la mañana en texto para leer en voz alta
 *   (automatización «a las 8:00»).
 * - `POST /api/atajo/datos` `{ tipo: 'salud' | 'calendario', … }`: solo los campos que
 *   Nico elige en el atajo van a su memoria (`notas/salud.md`, `notas/agenda.md`). Un
 *   campo que no está en la lista se ignora y se dice: nunca se guarda nada de Salud
 *   más allá de lo que él mandó, y una línea por día (se corrige, no se acumula).
 */
import type { MemoryEntry, RememberOptions } from '../memory.js';
import { sliceSafe } from '../text.js';

export type EventoLugar = 'llegar' | 'salir';

/** `{ evento, sitio }` del cuerpo de `/api/atajo/lugar`, o un texto de error para leer. */
export function leerLugar(
  body: Record<string, unknown>,
): { evento: EventoLugar; sitio: string } | { error: string } {
  const raw = typeof body.evento === 'string' ? body.evento.trim().toLowerCase() : '';
  const evento: EventoLugar | null = /^(llegar|llegada|llego|entrar)$/.test(raw)
    ? 'llegar'
    : /^(salir|salida|salgo|irme)$/.test(raw)
      ? 'salir'
      : null;
  if (!evento) return { error: 'Falta el evento del atajo: pon «llegar» o «salir».' };
  const sitio = typeof body.sitio === 'string' && body.sitio.trim() ? body.sitio.trim() : 'casa';
  if (sitio.length > 60) return { error: 'El nombre del sitio es demasiado largo.' };
  return { evento, sitio };
}

/**
 * Quita lo que «Leer texto» del iPhone diría mal en voz alta: emojis y símbolos sueltos.
 * El texto sigue igual para leerlo en pantalla.
 */
export function paraVoz(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Número tal y como llega de Atajos: 8432, «8432», «8.432» (miles) o «7,5». */
export function numeroAtajo(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Los campos de Salud que se aceptan. Lo demás no se guarda. */
export const CAMPOS_SALUD = ['pasos', 'sueno_horas', 'ejercicio_min'] as const;
const CAMPOS_COMUNES = ['tipo', 'fecha'];
export const MAX_EVENTOS = 15;
const MAX_EVENTO = 120;

export interface DatosIphone {
  tipo: 'salud' | 'calendario';
  /** AAAA-MM-DD del día de los datos. */
  fecha: string;
  tema: 'salud' | 'agenda';
  /** Etiqueta que marca la línea de ese día (para corregirla en vez de repetirla). */
  etiqueta: string;
  /** El principio de la línea: `Salud (iPhone) 2026-11-07:`. */
  prefijo: string;
  linea: string;
  /** Lo que se dijo que no se guarda (campos fuera de la lista). */
  ignorados: string[];
}

function horasYMinutos(horas: number): string {
  const total = Math.round(horas * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function fechaDe(raw: unknown, hoy: string): string | null {
  if (raw === undefined || raw === null || raw === '') return hoy;
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(a, mes - 1, dia));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia)
    return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function eventosDe(raw: unknown): string[] | null {
  const lista = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string')
    : typeof raw === 'string'
      ? raw.split(/\r?\n|;/)
      : null;
  if (!lista) return null;
  return lista
    .map((e) => e.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_EVENTOS)
    .map((e) => (e.length > MAX_EVENTO ? `${sliceSafe(e, MAX_EVENTO - 1)}…` : e));
}

/** Valida el cuerpo de `/api/atajo/datos`. `hoy` es AAAA-MM-DD local. */
export function leerDatos(
  body: Record<string, unknown>,
  hoy: string,
): DatosIphone | { error: string } {
  const tipo = typeof body.tipo === 'string' ? body.tipo.trim().toLowerCase() : '';
  const fecha = fechaDe(body.fecha, hoy);
  if (!fecha) return { error: 'La fecha del atajo no se entiende: usa el formato AAAA-MM-DD.' };
  if (tipo === 'salud') {
    const ignorados = Object.keys(body).filter(
      (k) => !CAMPOS_COMUNES.includes(k) && !(CAMPOS_SALUD as readonly string[]).includes(k),
    );
    const partes: string[] = [];
    const pasos = numeroAtajo(body.pasos);
    if (pasos !== null && pasos >= 0 && pasos <= 200_000) partes.push(`${Math.round(pasos)} pasos`);
    const sueno = numeroAtajo(body.sueno_horas);
    if (sueno !== null && sueno > 0 && sueno <= 24) partes.push(`durmió ${horasYMinutos(sueno)}`);
    const ejercicio = numeroAtajo(body.ejercicio_min);
    if (ejercicio !== null && ejercicio > 0 && ejercicio <= 1440)
      partes.push(`${Math.round(ejercicio)} min de ejercicio`);
    if (!partes.length)
      return {
        error:
          'No me ha llegado ningún dato de Salud que entienda. Manda pasos, sueno_horas o ejercicio_min con un número.',
      };
    const prefijo = `Salud (iPhone) ${fecha}:`;
    return {
      tipo: 'salud',
      fecha,
      tema: 'salud',
      etiqueta: 'iphone-salud',
      prefijo,
      linea: `${prefijo} ${partes.join('; ')}`,
      ignorados,
    };
  }
  if (tipo === 'calendario' || tipo === 'agenda') {
    const ignorados = Object.keys(body).filter(
      (k) => !CAMPOS_COMUNES.includes(k) && k !== 'eventos',
    );
    const eventos = eventosDe(body.eventos);
    if (!eventos)
      return { error: 'Faltan los eventos: manda «eventos» con el texto del calendario.' };
    const prefijo = `Agenda (iPhone) ${fecha}:`;
    return {
      tipo: 'calendario',
      fecha,
      tema: 'agenda',
      etiqueta: 'iphone-agenda',
      prefijo,
      linea: `${prefijo} ${eventos.length ? eventos.join('; ') : 'sin eventos'}`,
      ignorados,
    };
  }
  return { error: 'Falta el tipo del atajo: pon «salud» o «calendario».' };
}

export interface MemoriaAtajo {
  all(scope: string): MemoryEntry[];
  remember(scope: string, text: string, opts?: RememberOptions): MemoryEntry;
}

/**
 * Guarda la línea del día en la memoria del dueño. Si ya hay una de ese día y ese tipo,
 * la corrige en su sitio (el atajo puede correr varias veces al día). Devuelve la frase
 * para el atajo. Nunca lanza.
 */
export function guardarDatosIphone(
  memory: MemoriaAtajo,
  scope: string,
  datos: DatosIphone,
): string {
  try {
    const previa = memory
      .all(scope)
      .find(
        (e) =>
          !e.supersededBy && e.tags.includes(datos.etiqueta) && e.text.startsWith(datos.prefijo),
      );
    memory.remember(scope, datos.linea, {
      tags: ['iphone', datos.etiqueta],
      tema: datos.tema,
      ...(previa ? { id: previa.id } : {}),
    });
  } catch {
    return 'No he podido guardarlo en la memoria. Prueba otra vez en un rato.';
  }
  const lo = datos.linea.slice(datos.prefijo.length).trim();
  const aviso = datos.ignorados.length
    ? ` No he guardado ${datos.ignorados.join(', ')}: no está en la lista de lo que apunto.`
    : '';
  return `Apuntado en tu memoria (${datos.tema}, ${datos.fecha}): ${lo}.${aviso}`;
}

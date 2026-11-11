/**
 * /biblioteca: lo que Asistenta te ha hecho (gráficas, Excel, PDF, Word…), desde Telegram.
 *
 * Grok Bot tiene una «Library» con todo lo que el bot creó, filtrable por tipo
 * (https://docs.x.ai/grok-bot/files-and-results). Aquí ya se guardaba una copia de cada
 * archivo generado (src/creados.ts) pero solo se veía en el panel, que pide Tailscale; desde
 * el chat no había forma de recuperar «la gráfica de ayer» sin pedir que la rehiciera.
 *
 * - `/biblioteca` — los 10 últimos, del más nuevo al más viejo, con un botón «📤 N» por
 *   archivo que te lo vuelve a mandar.
 * - `/biblioteca pdf|excel|word|graficas|csv` — solo ese tipo.
 * - `/biblioteca N` — te manda el N de la lista.
 * Solo lectura: no borra ni cambia nada; la carpeta se poda sola (40 archivos, 50 MB).
 */
import { createHash } from 'node:crypto';
import type { Creado } from './creados.js';
import { localDay, localTimeZone } from './datecontext.js';

export const BIBLIOTECA_MAX = 10;

type Tipo = 'pdf' | 'excel' | 'word' | 'imagen' | 'csv' | 'texto' | 'otro';

const EXT: Record<string, Tipo> = {
  pdf: 'pdf',
  xlsx: 'excel',
  xls: 'excel',
  docx: 'word',
  doc: 'word',
  png: 'imagen',
  jpg: 'imagen',
  jpeg: 'imagen',
  csv: 'csv',
  txt: 'texto',
  md: 'texto',
};
const ICON: Record<Tipo, string> = {
  pdf: '📄',
  excel: '📊',
  word: '📝',
  imagen: '🖼️',
  csv: '🧾',
  texto: '🗒️',
  otro: '📎',
};

export function tipoDe(nombre: string): Tipo {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(nombre)?.[1]?.toLowerCase() ?? '';
  return EXT[ext] ?? 'otro';
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** «pdf», «excels», «hojas de cálculo», «gráficas», «fotos»… → el tipo; null = palabra que no es un tipo. */
export function filtroDe(word: string): Tipo | null {
  const w = fold(word).replace(/^(los|las|el|la|mis)\s+/, '');
  if (!w) return null;
  if (/^pdfs?$/.test(w)) return 'pdf';
  if (/^(excels?|xlsx?|hojas?( de calculo)?)$/.test(w)) return 'excel';
  if (/^(words?|docx?|documentos?)$/.test(w)) return 'word';
  if (/^(graficas?|graficos?|imagen(es)?|fotos?|pngs?)$/.test(w)) return 'imagen';
  if (/^csvs?$/.test(w)) return 'csv';
  if (/^(textos?|notas?|txt|md)$/.test(w)) return 'texto';
  return null;
}

const size = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

function cuando(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: tz() });
  const day = localDay(d);
  if (day === localDay(new Date(now))) return `hoy ${hm}`;
  if (day === localDay(new Date(now - 86_400_000))) return `ayer ${hm}`;
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: tz() });
}
const tz = () => localTimeZone();

/** La parte de fecha del id («20261111-120000» o «…-2»): cabe en un botón (64 bytes). */
export function claveDe(id: string): string {
  return /^\d{8}-\d{6}(?:-\d{1,2}(?=-))?/.exec(id)?.[0] ?? '';
}

/** Huella corta del id, para distinguir dos archivos hechos en el mismo segundo. */
function huella(id: string): string {
  return `h${createHash('sha1').update(id).digest('hex').slice(0, 6)}`;
}

/**
 * La clave del botón «📤 N»: la fecha al segundo y, si otro archivo de la lista comparte
 * ese segundo (la gráfica y su Excel salen a la vez), también su huella. Antes los dos
 * tenían la misma clave y «📤 2» mandaba el archivo 1.
 */
export function claveBoton(c: Creado, lista: readonly Creado[]): string {
  const k = claveDe(c.id);
  if (!k) return '';
  const twins = lista.filter((o) => o.id !== c.id && claveDe(o.id) === k).length;
  return twins ? `${k}-${huella(c.id)}` : k;
}

export interface BibliotecaView {
  text: string;
  /** «📤 N»: subcomando `enviar` con la clave del archivo. */
  sends: Array<{ label: string; clave: string }>;
}

export function bibliotecaVista(
  lista: readonly Creado[],
  filtro: Tipo | null,
  now: number = Date.now(),
): BibliotecaView {
  const all = filtro ? lista.filter((c) => tipoDe(c.nombre) === filtro) : [...lista];
  if (!lista.length)
    return {
      text: '📚 Aún no te he hecho ningún archivo. Pídeme una gráfica, un Excel o un PDF y aquí lo tendrás.',
      sends: [],
    };
  if (!all.length)
    return {
      text: `📚 No tengo ningún ${filtro} de los que te he hecho. /biblioteca para verlo todo.`,
      sends: [],
    };
  const shown = all.slice(0, BIBLIOTECA_MAX);
  const lines = shown.map(
    (c, i) =>
      `${i + 1}. ${ICON[tipoDe(c.nombre)]} ${c.nombre} · ${size(c.bytes)} · ${cuando(c.creado, now)}`,
  );
  const more = all.length > shown.length ? `\n…y ${all.length - shown.length} más.` : '';
  return {
    text:
      `📚 Lo que te he hecho${filtro ? ` (${filtro})` : ''}: ${all.length}\n${lines.join('\n')}${more}\n\n` +
      'Toca 📤 para que te lo mande otra vez, o «/biblioteca N». También te lo adjunto a un correo si me dices su nombre.',
    sends: shown
      .map((c, i) => ({ label: `📤 ${i + 1}`, clave: claveBoton(c, lista) }))
      .filter((s) => s.clave),
  };
}

/** Qué pide `/biblioteca <args>`. */
export type BibliotecaOrden =
  | { kind: 'lista'; filtro: Tipo | null }
  | { kind: 'enviar'; n: number; filtro: Tipo | null }
  | { kind: 'clave'; clave: string }
  | { kind: 'ayuda'; why: string };

export function bibliotecaOrden(args: string): BibliotecaOrden {
  const a = args.trim();
  if (!a) return { kind: 'lista', filtro: null };
  const send = /^enviar\s+(\d{8}-\d{6}(?:-\d{1,2})?(?:-h[0-9a-f]{6})?)$/i.exec(a);
  if (send?.[1]) return { kind: 'clave', clave: send[1] };
  const parts = a.split(/\s+/);
  const last = parts[parts.length - 1] ?? '';
  if (/^\d{1,2}$/.test(last)) {
    const filtro = parts.length > 1 ? filtroDe(parts.slice(0, -1).join(' ')) : null;
    if (parts.length > 1 && !filtro) return { kind: 'ayuda', why: a };
    return { kind: 'enviar', n: Number(last), filtro };
  }
  const filtro = filtroDe(a);
  return filtro ? { kind: 'lista', filtro } : { kind: 'ayuda', why: a };
}

/** El archivo que pide una orden; null si no existe (ya podado o número fuera de lista). */
export function bibliotecaElegir(lista: readonly Creado[], orden: BibliotecaOrden): Creado | null {
  if (orden.kind === 'clave') {
    const m = /^(.*)-(h[0-9a-f]{6})$/i.exec(orden.clave);
    if (m)
      return (
        lista.find((c) => claveDe(c.id) === m[1] && huella(c.id) === m[2]?.toLowerCase()) ?? null
      );
    return lista.find((c) => claveDe(c.id) === orden.clave) ?? null;
  }
  if (orden.kind !== 'enviar') return null;
  const all = orden.filtro ? lista.filter((c) => tipoDe(c.nombre) === orden.filtro) : lista;
  return orden.n >= 1 && orden.n <= BIBLIOTECA_MAX ? (all[orden.n - 1] ?? null) : null;
}

export const BIBLIOTECA_AYUDA =
  'Uso: /biblioteca (lo último que te he hecho), /biblioteca pdf|excel|word|graficas|csv, o /biblioteca N para que te lo mande.';

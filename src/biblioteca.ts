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
 * - `/biblioteca factura` (o `buscar factura`) — los que se llaman así, como el buscador de la
 *   Library de Grok Bot (Cmd/Ctrl+K, https://docs.x.ai/grok-bot/files-and-results): con más
 *   de 10 archivos, «la gráfica de gastos» de hace dos semanas ya no salía en la lista.
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

/** «No tengo ningún PDF» / «ninguna imagen»: el tipo con su artículo (imagen es femenino). */
const NINGUN: Record<Tipo, string> = {
  pdf: 'ningún PDF',
  excel: 'ningún Excel',
  word: 'ningún Word',
  imagen: 'ninguna imagen',
  csv: 'ningún CSV',
  texto: 'ningún texto',
  otro: 'ningún archivo de ese tipo',
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
  /**
   * «📌 Fijar N» / «Soltar N» de cada fila (subcomando `fijar`/`soltar` con la misma clave
   * que «📤 N»): fijar con un toque, sin escribir el número (Grok Bot «Pin»,
   * https://docs.x.ai/grok-bot/files-and-results). Va con la clave y no con N porque al
   * fijar algo la lista se reordena y «fijar 3» de un mensaje viejo sería otro archivo.
   */
  pins: Array<{ label: string; clave: string; sub: 'fijar' | 'soltar' }>;
}

/**
 * El orden de la lista: lo fijado arriba (Grok Bot, «Pin» en su Library,
 * https://docs.x.ai/grok-bot/files-and-results), luego lo demás, siempre lo más nuevo
 * primero. «📤 N», «/biblioteca N» y «fijar N» cuentan con este mismo orden.
 */
export function ordenBiblioteca(
  lista: readonly Creado[],
  fijados: ReadonlySet<string> = new Set(),
): Creado[] {
  return [...lista.filter((c) => fijados.has(c.id)), ...lista.filter((c) => !fijados.has(c.id))];
}

/** Las palabras de una búsqueda, sin tildes ni mayúsculas, y sin «de/la/el…». */
function palabras(texto: string): string[] {
  return fold(texto)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 1 && !/^(de|del|la|el|los|las|un|una|que|me|mi|mis)$/.test(w));
}

/** ¿Se llama así? Todas las palabras de la búsqueda en el nombre (sin tildes; «-» y «_» son espacios). */
export function coincide(nombre: string, busca: string): boolean {
  const ws = palabras(busca);
  if (!ws.length) return false;
  const n = fold(nombre).replace(/[-_.]+/g, ' ');
  return ws.every((w) => n.includes(w));
}

export function bibliotecaVista(
  lista: readonly Creado[],
  filtro: Tipo | null,
  now: number = Date.now(),
  fijados: ReadonlySet<string> = new Set(),
  busca?: string,
): BibliotecaView {
  const ordered = ordenBiblioteca(lista, fijados);
  const porTipo = filtro ? ordered.filter((c) => tipoDe(c.nombre) === filtro) : ordered;
  const all = busca ? porTipo.filter((c) => coincide(c.nombre, busca)) : porTipo;
  if (!lista.length)
    return {
      text: '📚 Aún no te he hecho ningún archivo. Pídeme una gráfica, un Excel o un PDF y aquí lo tendrás.',
      sends: [],
      pins: [],
    };
  if (!all.length && busca)
    return {
      text: `📚 No encuentro nada que se llame «${busca}» entre los ${lista.length} archivos que te he hecho. /biblioteca para verlos todos.`,
      sends: [],
      pins: [],
    };
  if (!all.length)
    return {
      text: `📚 No tengo ${NINGUN[filtro ?? 'otro']} de los que te he hecho. /biblioteca para verlo todo.`,
      sends: [],
      pins: [],
    };
  const shown = all.slice(0, BIBLIOTECA_MAX);
  const lines = shown.map(
    (c, i) =>
      `${i + 1}. ${fijados.has(c.id) ? '📌 ' : ''}${ICON[tipoDe(c.nombre)]} ${c.nombre} · ${size(c.bytes)} · ${cuando(c.creado, now)}`,
  );
  const more = all.length > shown.length ? `\n…y ${all.length - shown.length} más.` : '';
  return {
    text:
      `📚 ${busca ? `Lo que se llama «${busca}»` : 'Lo que te he hecho'}${filtro ? ` (${filtro})` : ''}: ${all.length}\n${lines.join('\n')}${more}\n\n` +
      'Toca 📤 para que te lo mande otra vez, o «/biblioteca N». También te lo adjunto a un correo si me dices su nombre.\n' +
      '📌 Toca «📌 Fijar» (o «/biblioteca fijar N») y lo dejo arriba sin borrarlo nunca (guardo los 40 últimos).',
    sends: shown
      .map((c, i) => ({ label: `📤 ${i + 1}`, clave: claveBoton(c, lista) }))
      .filter((s) => s.clave),
    pins: shown
      .map((c, i) => {
        const fijado = fijados.has(c.id);
        return {
          label: fijado ? `Soltar ${i + 1}` : `📌 Fijar ${i + 1}`,
          clave: claveBoton(c, lista),
          sub: fijado ? ('soltar' as const) : ('fijar' as const),
        };
      })
      .filter((s) => s.clave),
  };
}

/** Qué pide `/biblioteca <args>`. */
export type BibliotecaOrden =
  | { kind: 'lista'; filtro: Tipo | null; busca?: string }
  | { kind: 'enviar'; n: number; filtro: Tipo | null }
  | { kind: 'clave'; clave: string }
  /**
   * «/biblioteca fijar N» / «soltar N» (N de la lista sin filtro). El botón «📌 Fijar N»
   * manda la clave del archivo en vez de N (n = 0): sigue siendo el mismo archivo aunque la
   * lista se haya reordenado desde que salió el mensaje.
   */
  | { kind: 'fijar' | 'soltar'; n: number; clave?: string }
  | { kind: 'ayuda'; why: string };

export function bibliotecaOrden(args: string): BibliotecaOrden {
  const a = args.trim();
  if (!a) return { kind: 'lista', filtro: null };
  const pin = /^(fijar|fija|anclar|soltar|suelta|desfijar|desanclar)\s+(\d{1,2})$/i.exec(a);
  if (pin?.[1] && pin[2])
    return {
      kind: /^(fijar|fija|anclar)$/i.test(pin[1]) ? 'fijar' : 'soltar',
      n: Number(pin[2]),
    };
  const pinClave = /^(fijar|soltar)\s+(\d{8}-\d{6}(?:-\d{1,2})?(?:-h[0-9a-f]{6})?)$/i.exec(a);
  if (pinClave?.[1] && pinClave[2])
    return {
      kind: pinClave[1].toLowerCase() === 'fijar' ? 'fijar' : 'soltar',
      n: 0,
      clave: pinClave[2],
    };
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
  if (filtro) return { kind: 'lista', filtro };
  // «/biblioteca factura», «buscar gastos octubre», «pdf factura»: por nombre. Una orden mal
  // escrita («fijar abc») no es una búsqueda: la ayuda.
  if (/^(fijar|fija|anclar|soltar|suelta|desfijar|desanclar|enviar)\b/i.test(a))
    return { kind: 'ayuda', why: a };
  const b = /^(?:buscar?|busca|encuentra)\s+(.+)$/i.exec(a)?.[1] ?? a;
  const tipo = filtroDe(b.split(/\s+/)[0] ?? '');
  const texto = tipo ? b.split(/\s+/).slice(1).join(' ') : b;
  if (palabras(texto).length && texto.length <= 60)
    return { kind: 'lista', filtro: tipo, busca: texto.trim() };
  return { kind: 'ayuda', why: a };
}

/** El archivo de una clave de botón («20261111-120000» o «…-h1a2b3c»). */
function porClave(lista: readonly Creado[], clave: string): Creado | null {
  const m = /^(.*)-(h[0-9a-f]{6})$/i.exec(clave);
  if (m)
    return (
      lista.find((c) => claveDe(c.id) === m[1] && huella(c.id) === m[2]?.toLowerCase()) ?? null
    );
  return lista.find((c) => claveDe(c.id) === clave) ?? null;
}

/** El archivo que pide una orden; null si no existe (ya podado o número fuera de lista). */
export function bibliotecaElegir(
  lista: readonly Creado[],
  orden: BibliotecaOrden,
  fijados: ReadonlySet<string> = new Set(),
): Creado | null {
  if (orden.kind === 'clave') return porClave(lista, orden.clave);
  if ((orden.kind === 'fijar' || orden.kind === 'soltar') && orden.clave)
    return porClave(lista, orden.clave);
  const ordered = ordenBiblioteca(lista, fijados);
  if (orden.kind === 'fijar' || orden.kind === 'soltar')
    return orden.n >= 1 && orden.n <= BIBLIOTECA_MAX ? (ordered[orden.n - 1] ?? null) : null;
  if (orden.kind !== 'enviar') return null;
  const all = orden.filtro ? ordered.filter((c) => tipoDe(c.nombre) === orden.filtro) : ordered;
  return orden.n >= 1 && orden.n <= BIBLIOTECA_MAX ? (all[orden.n - 1] ?? null) : null;
}

/** La respuesta a «fijar N» / «soltar N» (lo hace `CreadosStore.fijar/soltar`). */
export function textoFijar(
  kind: 'fijar' | 'soltar',
  c: Creado | null,
  r: 'ok' | 'ya' | 'lleno' | 'no' | boolean,
  max: number,
): string {
  if (!c) return 'No tengo ese número en la lista. /biblioteca para verla.';
  if (kind === 'soltar')
    return r
      ? `Suelto «${c.nombre}»: vuelve a la lista normal (se borra cuando haya 40 más nuevos).`
      : `«${c.nombre}» no estaba fijado.`;
  if (r === 'ya') return `📌 «${c.nombre}» ya estaba fijado.`;
  if (r === 'lleno')
    return `Ya tienes ${max} fijados, que es el tope. Suelta alguno con «/biblioteca soltar N».`;
  if (r !== 'ok') return 'Ese archivo ya no lo tengo. /biblioteca para ver los que quedan.';
  return `📌 Fijado «${c.nombre}»: sale arriba en /biblioteca y no se borra. «/biblioteca soltar N» lo suelta.`;
}

/**
 * 📌 desde el panel («Páginas» → «📌 Fijar»/«Soltar»): lo mismo que «/biblioteca fijar N»,
 * por id. `ok: false` solo si el archivo ya no está (el panel lo dice y repinta).
 */
export function fijarPorId(
  store: {
    lista(): Creado[];
    fijar(id: string): 'ok' | 'ya' | 'lleno' | 'no';
    soltar(id: string): boolean;
  },
  id: string,
  fijar: boolean,
  max: number,
): { ok: boolean; mensaje: string } {
  const c = store.lista().find((x) => x.id === id) ?? null;
  if (!c) return { ok: false, mensaje: 'Ese archivo ya no lo tengo (guardo los 40 últimos).' };
  const r = fijar ? store.fijar(id) : store.soltar(id);
  const mensaje = textoFijar(fijar ? 'fijar' : 'soltar', c, r, max).replace(
    / «\/biblioteca soltar N» lo suelta\.$/,
    '',
  );
  return { ok: r !== 'no', mensaje };
}

export const BIBLIOTECA_AYUDA =
  'Uso: /biblioteca (lo último que te he hecho), /biblioteca pdf|excel|word|graficas|csv, /biblioteca <nombre> para buscarlo, /biblioteca N para que te lo mande, o /biblioteca fijar|soltar N para que no se borre.';

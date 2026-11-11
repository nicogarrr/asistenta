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

type Grupo = 'fijado' | 'hoy' | 'semana' | 'antes';
const GRUPO: Record<Grupo, string> = {
  fijado: '📌 Fijados',
  hoy: 'Hoy',
  semana: 'Esta semana',
  antes: 'Antes',
};

/** Días locales entre dos instantes (por fecha en su zona, no por 24 h). */
function diasEntre(a: number, b: number): number {
  const d = (ms: number) => Date.parse(`${localDay(new Date(ms))}T12:00:00Z`);
  return Math.round((d(b) - d(a)) / 86_400_000);
}

function grupoDe(c: Creado, fijados: ReadonlySet<string>, now: number): Grupo {
  if (fijados.has(c.id)) return 'fijado';
  const dias = diasEntre(c.creado, now);
  if (dias <= 0) return 'hoy';
  if (dias < 7) return 'semana';
  return 'antes';
}

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

/** La palabra del tipo para escribirlo en una orden: «/biblioteca graficas 2». */
const PALABRA: Record<Tipo, string> = {
  pdf: 'pdf',
  excel: 'excel',
  word: 'word',
  imagen: 'graficas',
  csv: 'csv',
  texto: 'notas',
  otro: '',
};

/**
 * Las dos líneas de ayuda bajo la lista. Los números de una lista filtrada son los de esa
 * lista: «/biblioteca fijar 1» tras «/biblioteca pdf» fijaba el 1 de la lista ENTERA (otro
 * archivo, bugs-36). La orden lleva el tipo y la búsqueda de esa lista.
 */
function pistaNumeros(filtro: Tipo | null, busca?: string): string {
  const fijar = '📌 Toca «📌 Fijar»';
  const resto = ' y lo dejo arriba sin borrarlo nunca (guardo los 40 últimos).';
  // Con búsqueda, la orden lleva la búsqueda: «/biblioteca factura 2» (bugs-37; antes solo
  // los botones, porque «/biblioteca 2» mandaba el 2 de la lista entera).
  const t = `${filtro ? `${PALABRA[filtro]} ` : ''}${busca ? `${busca} ` : ''}`;
  if (busca)
    return (
      `Toca 📤 para que te lo mande otra vez, o «/biblioteca ${t}N». También te lo adjunto a un correo si me dices su nombre.\n` +
      `${fijar}${resto}`
    );
  return (
    `Toca 📤 para que te lo mande otra vez, o «/biblioteca ${t}N». También te lo adjunto a un correo si me dices su nombre.\n` +
    `${fijar} (o «/biblioteca ${t}fijar N»)${resto}`
  );
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
  const rows = shown.map(
    (c, i) =>
      `${i + 1}. ${fijados.has(c.id) ? '📌 ' : ''}${ICON[tipoDe(c.nombre)]} ${c.nombre} · ${size(c.bytes)} · ${cuando(c.creado, now)}`,
  );
  // «Hoy / Esta semana / Antes» (y lo fijado aparte), como la Library de Grok Bot
  // (https://docs.x.ai/grok-bot/files-and-results). Solo si hay más de un grupo: una lista
  // toda de hoy no necesita título. La numeración sigue igual (📤 N, fijar N).
  const grupos = shown.map((c) => grupoDe(c, fijados, now));
  const lines =
    new Set(grupos).size > 1
      ? rows.flatMap((r, i) =>
          i === 0 || grupos[i] !== grupos[i - 1] ? [`${GRUPO[grupos[i] ?? 'antes']}:`, r] : [r],
        )
      : rows;
  const more = all.length > shown.length ? `\n…y ${all.length - shown.length} más.` : '';
  return {
    text:
      `📚 ${busca ? `Lo que se llama «${busca}»` : 'Lo que te he hecho'}${filtro ? ` (${filtro})` : ''}: ${all.length}\n${lines.join('\n')}${more}\n\n` +
      pistaNumeros(filtro, busca),
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
  /**
   * «/biblioteca 3», «/biblioteca pdf 3» o, con `busca`, «/biblioteca factura 3»: el 3 de esa
   * lista (la misma que enseña «/biblioteca factura»).
   */
  | { kind: 'enviar'; n: number; filtro: Tipo | null; busca?: string }
  | { kind: 'clave'; clave: string }
  /**
   * «/biblioteca enlaces»: los enlaces que te he mandado (enlaces-enviados.ts). Con texto
   * («/biblioteca enlaces idealista»), los que lo llevan en la etiqueta o en la dirección.
   */
  | { kind: 'enlaces'; busca?: string }
  /**
   * «/biblioteca enlaces fijar N» / «… soltar N» (N de «/biblioteca enlaces»), o el botón
   * «📌 N» / «Soltar N» con la clave corta del enlace (enlaces-enviados.ts claveEnlace).
   */
  | { kind: 'enlace-pin'; fijar: boolean; n: number; clave?: string }
  /**
   * «/biblioteca fijar N» / «soltar N» (N de la lista sin filtro). El botón «📌 Fijar N»
   * manda la clave del archivo en vez de N (n = 0): sigue siendo el mismo archivo aunque la
   * lista se haya reordenado desde que salió el mensaje.
   */
  | { kind: 'fijar' | 'soltar'; n: number; clave?: string; filtro?: Tipo; busca?: string }
  | { kind: 'ayuda'; why: string };

export function bibliotecaOrden(args: string): BibliotecaOrden {
  const a = args.trim();
  if (!a) return { kind: 'lista', filtro: null };
  const pinEnlace =
    /^(?:enlaces?|links?)\s+(fijar|fija|anclar|soltar|suelta|desfijar)\s+(\d{1,2})$/i.exec(a);
  if (pinEnlace?.[1] && pinEnlace[2])
    return {
      kind: 'enlace-pin',
      fijar: /^(fijar|fija|anclar)$/i.test(pinEnlace[1]),
      n: Number(pinEnlace[2]),
    };
  const pinEnlaceClave = /^(fijarenlace|soltarenlace)\s+([0-9a-f]{10})$/i.exec(a);
  if (pinEnlaceClave?.[1] && pinEnlaceClave[2])
    return {
      kind: 'enlace-pin',
      fijar: pinEnlaceClave[1].toLowerCase() === 'fijarenlace',
      n: 0,
      clave: pinEnlaceClave[2].toLowerCase(),
    };
  // «fijar 2» cuenta en la lista entera; «pdf fijar 2» (o «fijar pdf 2»), en la de los PDF,
  // como «/biblioteca pdf 2» para mandarlo (bugs-36).
  const pin =
    /^(?:(\S+)\s+)?(fijar|fija|anclar|soltar|suelta|desfijar|desanclar)\s+(?:(\S+)\s+)?(\d{1,2})$/i.exec(
      a,
    );
  if (pin?.[2] && pin[4]) {
    const palabra = pin[1] ?? pin[3];
    const filtro = palabra ? filtroDe(palabra) : null;
    if (palabra && !filtro) return { kind: 'ayuda', why: a };
    return {
      kind: /^(fijar|fija|anclar)$/i.test(pin[2]) ? 'fijar' : 'soltar',
      n: Number(pin[4]),
      ...(filtro ? { filtro } : {}),
    };
  }
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
    const antes = parts.slice(0, -1).join(' ');
    const filtro = parts.length > 1 ? filtroDe(antes) : null;
    if (parts.length === 1 || filtro) return { kind: 'enviar', n: Number(last), filtro };
    // «/biblioteca factura 2» (el 2 de «/biblioteca factura») o «/biblioteca gastos 10»
    // (¿octubre?): antes daban la ayuda. `bibliotecaConBusqueda` decide con la lista si el
    // número es parte del nombre (bugs-37).
    const busca = textoDeBusqueda(antes);
    if (busca) return { kind: 'enviar', n: Number(last), filtro: busca.tipo, busca: busca.texto };
    return { kind: 'ayuda', why: a };
  }
  const filtro = filtroDe(a);
  if (filtro) return { kind: 'lista', filtro };
  if (/^(?:los\s+|mis\s+)?(?:enlaces?|links?|urls?)$/i.test(a)) return { kind: 'enlaces' };
  // «/biblioteca enlaces idealista», «enlaces del piso de Gijón»: buscar entre los enlaces (en
  // plural: «enlace raro» sigue siendo buscar un archivo con ese nombre).
  const enBusca =
    /^(?:los\s+|mis\s+)?(?:enlaces|links|urls)\s+(?:de\s+|del\s+|con\s+|sobre\s+)?(.{2,60})$/i
      .exec(a)?.[1]
      ?.trim();
  if (enBusca && !/^\d{1,2}$/.test(enBusca) && palabras(enBusca).length)
    return { kind: 'enlaces', busca: enBusca };
  // «/biblioteca factura», «buscar gastos octubre», «pdf factura»: por nombre. Una orden mal
  // escrita («fijar abc») no es una búsqueda: la ayuda.
  if (/^(fijar|fija|anclar|soltar|suelta|desfijar|desanclar|enviar)\b/i.test(a))
    return { kind: 'ayuda', why: a };
  const busca = textoDeBusqueda(a);
  if (busca) return { kind: 'lista', filtro: busca.tipo, busca: busca.texto };
  return { kind: 'ayuda', why: a };
}

/**
 * «factura», «buscar gastos de octubre», «pdf factura»: el tipo (si empieza por uno) y lo que
 * hay que buscar. null si no es una búsqueda (una orden mal escrita, «enlaces», sin palabras).
 */
function textoDeBusqueda(a: string): { tipo: Tipo | null; texto: string } | null {
  if (/^(fijar|fija|anclar|soltar|suelta|desfijar|desanclar|enviar)\b/i.test(a)) return null;
  if (/^(?:los\s+|mis\s+)?(?:enlaces?|links?|urls?)$/i.test(a)) return null;
  const b = /^(?:buscar?|busca|encuentra)\s+(.+)$/i.exec(a)?.[1] ?? a;
  const tipo = filtroDe(b.split(/\s+/)[0] ?? '');
  const texto = (tipo ? b.split(/\s+/).slice(1).join(' ') : b).trim();
  if (palabras(texto).length && texto.length <= 60) return { tipo, texto };
  return null;
}

/** La lista de una búsqueda (con su tipo), en el orden de /biblioteca. */
function deLaBusqueda(
  ordered: readonly Creado[],
  filtro: Tipo | null | undefined,
  busca: string | undefined,
): Creado[] {
  const porTipo = filtro ? ordered.filter((c) => tipoDe(c.nombre) === filtro) : [...ordered];
  return busca ? porTipo.filter((c) => coincide(c.nombre, busca)) : porTipo;
}

/**
 * «/biblioteca gastos 10»: ¿el 10 es parte del nombre («Gastos-10-2026.xlsx») o el número de
 * la lista de «gastos»? Si con el número hay algo que se llame así, la lista de eso; si no, y
 * «gastos» tiene un 10, ese; y si tampoco, la lista (que dice «no encuentro…» o enseña lo que
 * hay), en vez de «ya no lo tengo». Un número de una cifra nunca es parte de la búsqueda.
 */
export function bibliotecaConBusqueda(
  lista: readonly Creado[],
  orden: BibliotecaOrden,
  fijados: ReadonlySet<string> = new Set(),
): BibliotecaOrden {
  if (orden.kind !== 'enviar' || !orden.busca) return orden;
  const ordered = ordenBiblioteca(lista, fijados);
  const conNumero = `${orden.busca} ${orden.n}`;
  const numeroCuenta = palabras(String(orden.n)).length > 0;
  if (numeroCuenta && deLaBusqueda(ordered, orden.filtro, conNumero).length)
    return { kind: 'lista', filtro: orden.filtro, busca: conNumero };
  const de = deLaBusqueda(ordered, orden.filtro, orden.busca);
  if (orden.n >= 1 && orden.n <= Math.min(BIBLIOTECA_MAX, de.length)) return orden;
  return { kind: 'lista', filtro: orden.filtro, busca: numeroCuenta ? conNumero : orden.busca };
}

/** La última lista que se enseñó en un chat (cli.ts la guarda): para «/biblioteca 2» después. */
export interface BibliotecaUltimaVista {
  filtro: Tipo | null;
  busca?: string;
  at: number;
}

/**
 * Lo que se recuerda de la lista que se acaba de enseñar. Una búsqueda sin nada («No encuentro
 * nada que se llame…») no deja lista: «/biblioteca 2» después cuenta en la entera, no en una
 * búsqueda vacía que respondería otra vez «no encuentro» (bugs-37).
 */
export function vistaQueQueda(
  filtro: Tipo | null,
  busca: string | undefined,
  filas: number,
  now: number,
): BibliotecaUltimaVista | null {
  if (filas <= 0) return null;
  return { filtro, ...(busca ? { busca } : {}), at: now };
}

/** Cuánto vale «la última lista» para un «/biblioteca N» suelto. */
export const BIBLIOTECA_VISTA_MS = 30 * 60_000;

/**
 * «/biblioteca factura» y luego «/biblioteca 2»: el 2 es el de la lista que tiene delante (la
 * de «factura»), no el 2 de la lista entera, que es otro archivo (bugs-37; como #2361 con los
 * tipos). Solo un número suelto, y solo si esa lista salió hace menos de media hora.
 */
export function conVistaAnterior(
  orden: BibliotecaOrden,
  vista: BibliotecaUltimaVista | undefined,
  now: number = Date.now(),
): BibliotecaOrden {
  if (!vista || now - vista.at > BIBLIOTECA_VISTA_MS || now < vista.at) return orden;
  if (!vista.filtro && !vista.busca) return orden;
  const de = { ...(vista.busca ? { busca: vista.busca } : {}) };
  if (orden.kind === 'enviar' && !orden.filtro && !orden.busca)
    return { ...orden, filtro: vista.filtro, ...de };
  if ((orden.kind === 'fijar' || orden.kind === 'soltar') && !orden.clave && !orden.filtro)
    return { ...orden, ...(vista.filtro ? { filtro: vista.filtro } : {}), ...de };
  return orden;
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
  if (orden.kind !== 'fijar' && orden.kind !== 'soltar' && orden.kind !== 'enviar') return null;
  const de = deLaBusqueda(ordered, orden.filtro, orden.busca);
  return orden.n >= 1 && orden.n <= BIBLIOTECA_MAX ? (de[orden.n - 1] ?? null) : null;
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
  'Uso: /biblioteca (lo último que te he hecho), /biblioteca pdf|excel|word|graficas|csv, /biblioteca <nombre> para buscarlo, /biblioteca enlaces (los enlaces que te he mandado), /biblioteca N para que te lo mande, o /biblioteca fijar|soltar N para que no se borre.';

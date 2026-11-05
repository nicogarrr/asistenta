/**
 * Apuntes por tema («modo experto»): Nico mete sus apuntes de derecho (PDF, Word,
 * texto, fotos) en una carpeta por tema y, antes de contestar algo de ese tema,
 * Asistenta busca en ELLOS y cita de dónde sale cada cosa (archivo y página o
 * sección). La memoria documental (`memory/docs.ts`) guarda lo que llega a un chat;
 * esto es distinto: una estantería por TEMA, que él organiza a mano (soltar ficheros
 * en la carpeta) o por Telegram, y que se consulta antes de responder.
 *
 * Decisiones:
 * - La carpeta es la verdad: el índice (sqlite FTS5) se rehace por fichero cuando
 *   cambian su tamaño o su fecha, y un fichero borrado a mano sale del índice. Sin
 *   vigilante de carpetas (consumo): se mira al buscar, como mucho cada `rescanMs`.
 * - Troceo con su sitio: cada trozo lleva «pág. N» (PDF) y el último encabezado visto
 *   («Artículo 1544», «Tema 3», «# Arrendamientos»), para poder citar.
 * - Búsqueda léxica con prefijos (plurales y flexiones) y sin tildes; si hay
 *   embeddings locales (PA_SEMANTIC_RECALL=1) reordena los candidatos, igual que la
 *   memoria. Todo local y gratis: ningún apunte sale del PC.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '../log.js';
import { chunkText } from '../memory/docs.js';
import { extractOfficeText, officeKind } from '../memory/office.js';
import { type Embedder, hybridRank } from '../memory/semantic.js';
import { loadDatabaseSync } from '../sqlite.js';
import { decodeTextFile } from '../text-decode.js';
import { withTimeout } from '../utils.js';

/** Un trozo de texto con su sitio: página (PDF) o nada. */
export interface PaginaTexto {
  pag?: number;
  texto: string;
}

/** Lo que vuelve una búsqueda: el trozo, de qué fichero y de qué parte. */
export interface Pasaje {
  tema: string;
  archivo: string;
  /** «pág. 3, Artículo 1544», «Tema 2» o '' si no se sabe. */
  donde: string;
  texto: string;
  /** Fracción de las palabras de la pregunta que aparecen en el trozo (0..1). */
  cobertura: number;
}

export interface TemaInfo {
  nombre: string;
  archivos: number;
  trozos: number;
  /** Ficheros que no se pudieron leer (escaneados sin OCR, formato raro…). */
  sinLeer: { archivo: string; motivo: string }[];
  instrucciones: string;
}

export interface ResultadoIndexado {
  nuevos: number;
  cambiados: number;
  borrados: number;
  fallidos: { tema: string; archivo: string; motivo: string }[];
}

export interface BaseExpertosOptions {
  /** Carpeta raíz: un subdirectorio por tema. */
  root: string;
  /** Fichero sqlite del índice. */
  dbPath: string;
  /** OCR de fotos de apuntes (el local de Windows); sin él, las fotos quedan «sin leer». */
  ocr?: (bytes: Buffer, ext: string) => Promise<string | null>;
  /** Reordenación con embeddings locales (opcional). */
  embedder?: Embedder;
  /** Cada cuánto, como mucho, se vuelve a mirar la carpeta al buscar. */
  rescanMs?: number;
  now?: () => number;
  /** Test: sustituye la lectura de PDF. */
  pdfPages?: (bytes: Buffer) => Promise<PaginaTexto[]>;
}

/** Fichero con las instrucciones del tema («cita artículos, derecho español»). */
export const INSTRUCCIONES_FILE = '_instrucciones.txt';
const TROZO_CHARS = 1200;
const MAX_TROZOS_ARCHIVO = 2000;
const MAX_BYTES_ARCHIVO = 40 * 1024 * 1024;
const PDF_TIMEOUT_MS = 120_000;
const RESCAN_MS = 60_000;

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'text', 'rtf']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff']);
const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub']);

/** Sin tildes y en minúsculas: «Derecho Civil» y «derecho civil» son el mismo tema. */
export function plano(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Nombre de carpeta de un tema: minúsculas, sin tildes, solo letras, números, espacio,
 * guion y guion bajo. Nunca «..» ni rutas: «derecho/../../x» se queda en «derecho x».
 */
export function nombreTema(raw: string): string | null {
  const n = plano(raw)
    .replace(/[^a-z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return n && !n.startsWith('_') ? n : null;
}

/** Nombre de fichero seguro dentro del tema (sin rutas ni caracteres que Windows rechaza). */
export function nombreArchivo(raw: string): string | null {
  const n = [...basename(raw.replace(/\\/g, '/'))]
    .map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!n || n === '.' || n === '..' || n.startsWith('_') || n.startsWith('.')) return null;
  return n;
}

function extOf(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
}

/** ¿Sé leer este fichero? (lo demás de la carpeta se ignora sin ruido). */
export function sePuedeLeer(name: string): boolean {
  const e = extOf(name);
  return e === 'pdf' || TEXT_EXT.has(e) || OFFICE_EXT.has(e) || IMAGE_EXT.has(e);
}

const ENCABEZADO =
  /^\s{0,3}(?:#{1,4}\s+(.{2,80}?)\s*#*|((?:t[ií]tulo|cap[ií]tulo|secci[oó]n|art[ií]culo|art\.|tema|lecci[oó]n|disposici[oó]n\s+\w+)\s+[0-9ivxlcdmIVXLCDM][\w.ºª-]*(?:\s*(?:bis|ter))?\.?(?:\s*[-–:.]\s*.{0,60})?))\s*$/i;

/** Encabezado de una línea, o null. «Artículo 1544. Arrendamiento» → «Artículo 1544. Arrendamiento». */
export function encabezado(linea: string): string | null {
  if (linea.length > 110) return null;
  const m = ENCABEZADO.exec(linea);
  const h = (m?.[1] ?? m?.[2])?.replace(/[*_`]/g, '').trim();
  return h ? h.slice(0, 70) : null;
}

/**
 * Trocea páginas en pasajes de ~1.200 caracteres, cada uno con su sitio. El último
 * encabezado visto se arrastra entre páginas: un artículo que empieza en la pág. 3 y
 * sigue en la 4 se cita «pág. 4, Artículo 12».
 */
export function trocear(paginas: readonly PaginaTexto[]): { donde: string; texto: string }[] {
  const out: { donde: string; texto: string }[] = [];
  let seccion = '';
  for (const p of paginas) {
    const lineas = p.texto.replace(/\r\n?/g, '\n').split('\n');
    let actual: string[] = [];
    let seccionActual = seccion;
    const vaciar = () => {
      const txt = actual.join('\n').trim();
      if (txt) {
        const donde = [p.pag ? `pág. ${p.pag}` : '', seccionActual].filter(Boolean).join(', ');
        for (const t of chunkText(txt, TROZO_CHARS)) out.push({ donde, texto: t });
      }
      actual = [];
    };
    for (const l of lineas) {
      const h = encabezado(l);
      if (h) {
        vaciar();
        seccion = h;
        seccionActual = h;
      }
      actual.push(l);
    }
    vaciar();
  }
  return out;
}

/** pdfjs por página (se carga al primer PDF), con un tope de tiempo para todo. */
async function pdfPorPaginas(bytes: Buffer): Promise<PaginaTexto[]> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument(o: { data: Uint8Array }): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{
          getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
          cleanup(): void;
        }>;
      }>;
      destroy(): Promise<void>;
    };
  };
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const work = (async () => {
    const doc = await task.promise;
    const pages: PaginaTexto[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // hasEOL marca fin de línea: sin él, «Artículo 12» y el texto quedaban en una línea.
      const texto = content.items.map((it) => `${it.str ?? ''}${it.hasEOL ? '\n' : ''}`).join('');
      pages.push({ pag: n, texto });
      page.cleanup();
    }
    return pages;
  })();
  try {
    return await withTimeout(work, PDF_TIMEOUT_MS, 'lectura del PDF demasiado larga');
  } finally {
    await withTimeout(
      task.destroy().catch(() => {}),
      10_000,
      'pdf destroy',
    ).catch(() => {});
  }
}

const STOP = new Set(
  'que como cual cuales quien quienes donde cuando cuanto cuanta cuantos cuantas para por porque pero sino segun sobre entre hasta desde con sin una uno unos unas los las del al lo le les la el en y o u de se su sus mi mis tu tus es son era fue ser esta este esto estos estas ese esa eso esos esas hay han has ha he muy mas menos tambien ya no si me te nos os algo alguna alguno todo toda todos todas otra otro otros otras puede pueden dime explica explicame dame cuentame sabes saber hacer tiene tienen tengo dice dicen decir dijo significa habla hablan pone ponen sale salen mira busca consulta quiero necesito puedes podrias favor hola gracias apuntes apunte notas mis nuestros nuestras segun'.split(
    ' ',
  ),
);

/** Palabras con significado de una pregunta, sin tildes («¿Qué es el arrendamiento?» → [arrendamiento]). */
export function palabrasClave(q: string): string[] {
  const out: string[] = [];
  for (const w of plano(q).split(/[^a-z0-9ñ]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d{1,2}$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out.slice(0, 12);
}

const SUFIJOS = [
  'amientos',
  'imientos',
  'amiento',
  'imiento',
  'aciones',
  'iciones',
  'idades',
  'adores',
  'adoras',
  'mente',
  'acion',
  'icion',
  'ciones',
  'siones',
  'cion',
  'sion',
  'idad',
  'ador',
  'adora',
  'ables',
  'ibles',
  'able',
  'ible',
  'arios',
  'arias',
  'ario',
  'aria',
  'ados',
  'adas',
  'idos',
  'idas',
  'ado',
  'ada',
  'ido',
  'ida',
  'es',
  'os',
  'as',
  'en',
  'an',
  'ar',
  'er',
  'ir',
  's',
  'o',
  'a',
  'e',
];

/**
 * Raíz para buscar por prefijo, quitando terminaciones del castellano: «obligaciones» y
 * «obligado» → «oblig», «contratos» → «contrat», «prescripción» → «prescrip».
 */
export function raiz(w: string): string {
  if (/^\d+$/.test(w) || w.length <= 4) return w;
  for (const suf of SUFIJOS)
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  return w;
}

function cobertura(texto: string, claves: readonly string[]): number {
  if (claves.length === 0) return 0;
  const t = plano(texto);
  let n = 0;
  for (const c of claves) if (t.includes(raiz(c))) n++;
  return n / claves.length;
}

/** El trozo recortado alrededor de la primera coincidencia, para no llenar el prompt. */
export function recorte(texto: string, claves: readonly string[], max = 900): string {
  const limpio = texto
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (limpio.length <= max) return limpio;
  const t = plano(limpio);
  let pos = -1;
  for (const c of claves) {
    const i = t.indexOf(raiz(c));
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  const start = Math.max(0, Math.min(pos < 0 ? 0 : pos - Math.floor(max / 3), limpio.length - max));
  return `${start > 0 ? '…' : ''}${limpio.slice(start, start + max).trim()}${start + max < limpio.length ? '…' : ''}`;
}

export class BaseExpertos {
  readonly root: string;
  readonly #db: DatabaseSync;
  readonly #ocr?: BaseExpertosOptions['ocr'];
  readonly #embedder?: Embedder;
  readonly #rescanMs: number;
  readonly #now: () => number;
  readonly #pdfPages: (bytes: Buffer) => Promise<PaginaTexto[]>;
  #lastScan = Number.NEGATIVE_INFINITY;
  #scanning: Promise<ResultadoIndexado> | null = null;

  constructor(o: BaseExpertosOptions) {
    this.root = o.root;
    mkdirSync(o.root, { recursive: true });
    const Db = loadDatabaseSync();
    this.#db = new Db(o.dbPath);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS archivos (
        tema TEXT NOT NULL,
        archivo TEXT NOT NULL,
        firma TEXT NOT NULL,
        trozos INTEGER NOT NULL,
        motivo TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (tema, archivo)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS trozos USING fts5(
        texto,
        tema UNINDEXED,
        archivo UNINDEXED,
        donde UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    this.#ocr = o.ocr;
    this.#embedder = o.embedder;
    this.#rescanMs = o.rescanMs ?? RESCAN_MS;
    this.#now = o.now ?? Date.now;
    this.#pdfPages = o.pdfPages ?? pdfPorPaginas;
  }

  close(): void {
    this.#db.close();
  }

  carpeta(tema: string): string {
    return join(this.root, tema);
  }

  /** Temas = subcarpetas de la raíz (también las creadas a mano). */
  nombres(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && nombreTema(d.name) === d.name)
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** Busca un tema por cómo lo diga Nico («Derecho», «derecho civil»). */
  resolver(raw: string): string | null {
    const n = nombreTema(raw);
    if (!n) return null;
    const temas = this.nombres();
    if (temas.includes(n)) return n;
    // «derecho» encuentra «derecho civil» si es el único que empieza así.
    const pref = temas.filter((t) => t.startsWith(`${n} `) || t.startsWith(n));
    return pref.length === 1 ? (pref[0] ?? null) : null;
  }

  crear(raw: string, instrucciones?: string): string | null {
    const n = nombreTema(raw);
    if (!n) return null;
    mkdirSync(this.carpeta(n), { recursive: true });
    if (instrucciones?.trim()) this.fijarInstrucciones(n, instrucciones);
    return n;
  }

  instrucciones(tema: string): string {
    try {
      return readFileSync(join(this.carpeta(tema), INSTRUCCIONES_FILE), 'utf8')
        .trim()
        .slice(0, 600);
    } catch {
      return '';
    }
  }

  fijarInstrucciones(tema: string, texto: string): void {
    mkdirSync(this.carpeta(tema), { recursive: true });
    const file = join(this.carpeta(tema), INSTRUCCIONES_FILE);
    if (texto.trim()) writeFileSync(file, `${texto.trim().slice(0, 600)}\n`);
    else rmSync(file, { force: true });
  }

  /** Guarda un fichero en el tema (crea el tema si no existe) y lo indexa ya. */
  async anadir(
    raw: string,
    nombre: string,
    bytes: Buffer,
  ): Promise<{ tema: string; archivo: string; trozos: number; motivo: string } | null> {
    const tema = this.resolver(raw) ?? this.crear(raw);
    const archivo = nombreArchivo(nombre);
    if (!tema || !archivo) return null;
    writeFileSync(join(this.carpeta(tema), archivo), bytes);
    await this.reindexar(true);
    const row = this.#db
      .prepare('SELECT trozos, motivo FROM archivos WHERE tema = ? AND archivo = ?')
      .get(tema, archivo) as { trozos: number; motivo: string } | undefined;
    return { tema, archivo, trozos: row?.trozos ?? 0, motivo: row?.motivo ?? 'no se indexó' };
  }

  quitar(tema: string, archivo: string): boolean {
    const file = join(this.carpeta(tema), basename(archivo));
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    this.#olvidar(tema, basename(archivo));
    return true;
  }

  borrarTema(tema: string): boolean {
    if (!this.nombres().includes(tema)) return false;
    rmSync(this.carpeta(tema), { recursive: true, force: true });
    this.#db.prepare('DELETE FROM trozos WHERE tema = ?').run(tema);
    this.#db.prepare('DELETE FROM archivos WHERE tema = ?').run(tema);
    return true;
  }

  temas(): TemaInfo[] {
    return this.nombres().map((nombre) => {
      const rows = this.#db
        .prepare('SELECT archivo, trozos, motivo FROM archivos WHERE tema = ? ORDER BY archivo')
        .all(nombre) as { archivo: string; trozos: number; motivo: string }[];
      return {
        nombre,
        archivos: rows.length,
        trozos: rows.reduce((a, r) => a + r.trozos, 0),
        sinLeer: rows
          .filter((r) => r.motivo)
          .map((r) => ({ archivo: r.archivo, motivo: r.motivo })),
        instrucciones: this.instrucciones(nombre),
      };
    });
  }

  archivos(tema: string): { archivo: string; trozos: number; motivo: string }[] {
    return this.#db
      .prepare('SELECT archivo, trozos, motivo FROM archivos WHERE tema = ? ORDER BY archivo')
      .all(tema) as { archivo: string; trozos: number; motivo: string }[];
  }

  #olvidar(tema: string, archivo: string): void {
    this.#db.prepare('DELETE FROM trozos WHERE tema = ? AND archivo = ?').run(tema, archivo);
    this.#db.prepare('DELETE FROM archivos WHERE tema = ? AND archivo = ?').run(tema, archivo);
  }

  async #leer(file: string, name: string): Promise<{ paginas: PaginaTexto[]; motivo: string }> {
    const e = extOf(name);
    const bytes = readFileSync(file);
    if (bytes.length === 0) return { paginas: [], motivo: 'está vacío' };
    if (e === 'pdf') {
      const paginas = await this.#pdfPages(bytes);
      return paginas.some((p) => p.texto.trim())
        ? { paginas, motivo: '' }
        : {
            paginas: [],
            motivo: 'PDF escaneado sin texto (pásalo por /ocr o mándame las páginas como fotos)',
          };
    }
    if (OFFICE_EXT.has(e)) {
      const kind = officeKind('application/octet-stream', name);
      if (!kind) return { paginas: [], motivo: 'formato no soportado' };
      return { paginas: [{ texto: extractOfficeText(bytes, kind) }], motivo: '' };
    }
    if (TEXT_EXT.has(e)) return { paginas: [{ texto: decodeTextFile(bytes).text }], motivo: '' };
    if (IMAGE_EXT.has(e)) {
      if (!this.#ocr) return { paginas: [], motivo: 'foto: el OCR local no está disponible' };
      const txt = await this.#ocr(bytes, e);
      return txt?.trim()
        ? { paginas: [{ texto: txt }], motivo: '' }
        : { paginas: [], motivo: 'foto sin texto legible' };
    }
    return { paginas: [], motivo: 'formato no soportado' };
  }

  /**
   * Sincroniza el índice con las carpetas: indexa lo nuevo o cambiado, quita lo que ya no
   * está. `forzar` ignora el intervalo mínimo entre pasadas.
   */
  async reindexar(forzar = false): Promise<ResultadoIndexado> {
    if (this.#scanning) return this.#scanning;
    if (!forzar && this.#now() - this.#lastScan < this.#rescanMs)
      return { nuevos: 0, cambiados: 0, borrados: 0, fallidos: [] };
    this.#scanning = this.#reindexar().finally(() => {
      this.#scanning = null;
      this.#lastScan = this.#now();
    });
    return this.#scanning;
  }

  async #reindexar(): Promise<ResultadoIndexado> {
    const res: ResultadoIndexado = { nuevos: 0, cambiados: 0, borrados: 0, fallidos: [] };
    const temas = this.nombres();
    const conocidos = this.#db.prepare('SELECT tema, archivo, firma FROM archivos').all() as {
      tema: string;
      archivo: string;
      firma: string;
    }[];
    const firmas = new Map(conocidos.map((r) => [`${r.tema}\u0000${r.archivo}`, r.firma]));
    const vistos = new Set<string>();
    for (const tema of temas) {
      let entries: string[] = [];
      try {
        entries = readdirSync(this.carpeta(tema));
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.startsWith('_') || name.startsWith('.') || !sePuedeLeer(name)) continue;
        const file = join(this.carpeta(tema), name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const key = `${tema}\u0000${name}`;
        vistos.add(key);
        const firma = createHash('sha1')
          .update(`${st.size}:${Math.round(st.mtimeMs)}`)
          .digest('hex')
          .slice(0, 16);
        const antes = firmas.get(key);
        if (antes === firma) continue;
        let paginas: PaginaTexto[] = [];
        let motivo = '';
        if (st.size > MAX_BYTES_ARCHIVO) motivo = 'pesa más de 40 MB';
        else {
          try {
            ({ paginas, motivo } = await this.#leer(file, name));
          } catch (err) {
            motivo = `no se pudo leer (${err instanceof Error ? err.message : String(err)})`.slice(
              0,
              160,
            );
            log.warn('expertos: lectura fallida', { tema, archivo: name, err: String(err) });
          }
        }
        const trozos = motivo ? [] : trocear(paginas).slice(0, MAX_TROZOS_ARCHIVO);
        if (!motivo && trozos.length === 0) motivo = 'sin texto';
        this.#db.exec('BEGIN');
        try {
          this.#olvidar(tema, name);
          const ins = this.#db.prepare(
            'INSERT INTO trozos (texto, tema, archivo, donde) VALUES (?, ?, ?, ?)',
          );
          for (const t of trozos) ins.run(t.texto, tema, name, t.donde);
          this.#db
            .prepare(
              'INSERT INTO archivos (tema, archivo, firma, trozos, motivo) VALUES (?, ?, ?, ?, ?)',
            )
            .run(tema, name, firma, trozos.length, motivo);
          this.#db.exec('COMMIT');
        } catch (err) {
          this.#db.exec('ROLLBACK');
          throw err;
        }
        if (motivo) res.fallidos.push({ tema, archivo: name, motivo });
        if (antes === undefined) res.nuevos++;
        else res.cambiados++;
      }
    }
    for (const r of conocidos) {
      if (vistos.has(`${r.tema}\u0000${r.archivo}`)) continue;
      this.#olvidar(r.tema, r.archivo);
      res.borrados++;
    }
    return res;
  }

  /**
   * Los mejores pasajes para una pregunta, en un tema o en todos. Léxico (prefijos, sin
   * tildes, bm25) y, si hay embeddings, reordenado por significado.
   */
  async buscar(query: string, o: { tema?: string; limit?: number } = {}): Promise<Pasaje[]> {
    await this.reindexar();
    const claves = palabrasClave(query);
    if (claves.length === 0) return [];
    const match = claves.map((c) => `"${raiz(c).replace(/"/g, '')}"*`).join(' OR ');
    const limit = o.limit ?? 5;
    let rows: { texto: string; tema: string; archivo: string; donde: string }[];
    try {
      rows = this.#db
        .prepare(
          `SELECT texto, tema, archivo, donde FROM trozos WHERE trozos MATCH ?${o.tema ? ' AND tema = ?' : ''} ORDER BY bm25(trozos) LIMIT 60`,
        )
        .all(...(o.tema ? [match, o.tema] : [match])) as typeof rows;
    } catch (err) {
      log.warn('expertos: búsqueda fallida', { err: String(err) });
      return [];
    }
    let hits: Pasaje[] = rows.map((r) => ({ ...r, cobertura: cobertura(r.texto, claves) }));
    // bm25 primero, cobertura después: un trozo que tiene TODAS las palabras gana a uno que
    // repite mucho una sola.
    hits = hits
      .map((h, i) => ({ h, i }))
      .sort((a, b) => b.h.cobertura - a.h.cobertura || a.i - b.i)
      .map((x) => x.h);
    if (this.#embedder && hits.length > 1) {
      try {
        const n = hits.length;
        const orden = new Map(hits.map((h, i) => [h, i]));
        hits = await hybridRank({
          query,
          items: hits,
          text: (h) => h.texto,
          lexical: (h) => 4 * h.cobertura + (n - (orden.get(h) ?? n)) / n,
          embedder: this.#embedder,
          limit: hits.length,
        });
      } catch (err) {
        log.warn('expertos: embeddings no disponibles, sigo con léxico', { err: String(err) });
      }
    }
    return hits.slice(0, limit);
  }
}

/** «derecho.pdf, pág. 3, Artículo 1544» */
export function fuente(p: Pick<Pasaje, 'archivo' | 'donde'>): string {
  return p.donde ? `${p.archivo}, ${p.donde}` : p.archivo;
}

/**
 * La carpeta de memoria como bóveda de Obsidian (Nico, 7 nov: el tuit de @_DavidGF).
 *
 * Obsidian guarda las notas como ficheros .md normales en una carpeta. Encima de
 * eso pone tres cosas que aquí escribimos y leemos nosotros, sin depender de que
 * Obsidian esté instalado ni abierto:
 *
 * - propiedades: un bloque YAML entre `---` al principio de la nota (tags,
 *   aliases y lo que el usuario quiera);
 * - enlaces `[[nota]]`, `[[nota|texto]]`, `[[nota#apartado]]` y `![[incrustada]]`;
 * - enlaces inversos (backlinks): quién enlaza a una nota. Obsidian los calcula;
 *   `indiceEnlaces()` hace lo mismo leyendo los ficheros en cada llamada, así
 *   lo que Nico cambie en Obsidian se ve al momento.
 *
 * El CLI oficial de Obsidian (1.12, feb. 2026: `obsidian backlinks`, `links`,
 * `search`…) solo funciona con la app abierta, así que Asistenta no lo usa.
 *
 * Regla de oro: lo que Nico escribe se queda. De las propiedades solo tocamos
 * `updated`, `caduca` y añadimos nuestras etiquetas (las suyas se conservan); de
 * la línea «Relacionado:» solo la que lleva la marca `%%auto%%`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { localDay } from '../datecontext.js';
import { plegarTexto } from './temas.js';

/** `PA_OBSIDIAN=0` deja las notas como antes (sin propiedades ni «Relacionado»). */
export function obsidianActivo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PA_OBSIDIAN?.trim() !== '0';
}

/** Etiqueta común de todo lo que escribe Asistenta. */
export const ETIQUETA_ASISTENTA = 'asistenta';
/** Etiqueta del tema: `memoria/salud` (las etiquetas anidadas de Obsidian). */
export function etiquetaTema(tema: string): string {
  return `memoria/${tema}`;
}
/** Marca (comentario de Obsidian, no se ve al leer) de la línea que regenera Asistenta. */
export const MARCA_AUTO = '%%auto%%';
const RELACIONADO_AUTO = /^Relacionado:.*%%auto%%\s*$/;
const RELACIONADO_A_MANO = /^Relacionado:/i;
/** Propiedades que son de Asistenta: las demás son de Nico y no se tocan. */
const CLAVES_NUESTRAS = new Set(['tags', 'updated', 'caduca']);

export interface PartesNota {
  /** Líneas entre los `---` (sin ellos), o null si la nota no tiene propiedades. */
  fm: string[] | null;
  cuerpo: string[];
}

/** Separa las propiedades YAML del cuerpo. Un `---` sin cerrar no es un bloque de propiedades. */
export function separarFrontmatter(lineas: readonly string[]): PartesNota {
  if (lineas[0]?.replace(/^\uFEFF/, '').trim() !== '---') return { fm: null, cuerpo: [...lineas] };
  for (let i = 1; i < lineas.length; i++) {
    if ((lineas[i] ?? '').trim() === '---') {
      return { fm: lineas.slice(1, i), cuerpo: lineas.slice(i + 1) };
    }
  }
  return { fm: null, cuerpo: [...lineas] };
}

export function unirFrontmatter(p: PartesNota): string[] {
  return p.fm === null ? [...p.cuerpo] : ['---', ...p.fm, '---', ...p.cuerpo];
}

interface Bloque {
  clave: string | null;
  lineas: string[];
}

/** Bloques `clave: valor` (con sus líneas sangradas o de lista debajo). */
function bloques(fm: readonly string[]): Bloque[] {
  const out: Bloque[] = [];
  for (const l of fm) {
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(l);
    if (m) out.push({ clave: m[1] ?? null, lineas: [l] });
    else if (out.length > 0 && (/^\s/.test(l) || /^-\s/.test(l) || l.trim() === ''))
      out[out.length - 1]?.lineas.push(l);
    else out.push({ clave: null, lineas: [l] });
  }
  return out;
}

function sinComillas(v: string): string {
  return v
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^#/, '')
    .trim();
}

/** Valores de una propiedad de lista: `[a, b]`, `a, b`, `a b` o una lista `- a`. */
function valoresLista(b: Bloque, conEspacios = false): string[] {
  const primera = b.lineas[0] ?? '';
  const tras = primera.slice(primera.indexOf(':') + 1).trim();
  const out: string[] = [];
  if (tras) {
    const sinCorchetes = tras.replace(/^\[|\]$/g, '');
    // Etiquetas: «a b» son dos. Alias y demás: solo la coma separa («Mi diario» es uno).
    for (const v of sinCorchetes.split(conEspacios ? /,/ : /[,\s]+/))
      if (sinComillas(v)) out.push(sinComillas(v));
  }
  for (const l of b.lineas.slice(1)) {
    const m = /^\s*-\s*(.+)$/.exec(l);
    if (m?.[1] && sinComillas(m[1])) out.push(sinComillas(m[1]));
  }
  return out;
}

/** Lee una propiedad: texto (o lista unida por comas), o null si no está. */
export function leerPropiedad(fm: readonly string[] | null, clave: string): string[] | null {
  if (!fm) return null;
  const b = bloques(fm).find((x) => x.clave === clave);
  return b ? valoresLista(b, clave !== 'tags') : null;
}

export interface PropiedadesNuestras {
  /** Etiquetas que añadimos; las que ya tenga la nota se quedan. */
  tags: readonly string[];
  /** AAAA-MM-DD; undefined = no tocar `updated`. */
  updated?: string;
  /** AAAA-MM-DD de la caducidad más próxima; null = quitar la nuestra. */
  caduca: string | null;
}

/**
 * Pone nuestras propiedades sin perder las de Nico: las claves que no son nuestras
 * se quedan tal cual y en su sitio, y sus etiquetas se mantienen (las nuestras se
 * añaden si faltan).
 */
export function fijarPropiedades(fm: readonly string[] | null, p: PropiedadesNuestras): string[] {
  const bs = bloques(fm ?? []);
  const tagsBloque = bs.find((b) => b.clave === 'tags');
  const tags = tagsBloque ? valoresLista(tagsBloque) : [];
  for (const t of p.tags) if (!tags.includes(t)) tags.push(t);
  const nuevo: Record<string, string[] | null> = {
    tags: ['tags:', ...tags.map((t) => `  - ${t}`)],
    updated:
      p.updated !== undefined
        ? [`updated: ${p.updated}`]
        : (bs.find((b) => b.clave === 'updated')?.lineas ?? null),
    caduca: p.caduca ? [`caduca: ${p.caduca}`] : null,
  };
  const out: string[] = [];
  const puestas = new Set<string>();
  for (const b of bs) {
    if (b.clave && CLAVES_NUESTRAS.has(b.clave)) {
      if (puestas.has(b.clave)) continue; // una clave repetida: se queda una
      puestas.add(b.clave);
      const v = nuevo[b.clave];
      if (v) out.push(...v);
      continue;
    }
    out.push(...b.lineas);
  }
  for (const clave of ['tags', 'updated', 'caduca']) {
    if (puestas.has(clave)) continue;
    const v = nuevo[clave];
    if (v) out.push(...v);
  }
  return out;
}

/** true si las propiedades no llevan nada de Nico (solo lo que pone Asistenta). */
export function propiedadesSoloNuestras(fm: readonly string[] | null, tema: string): boolean {
  if (!fm) return true;
  const nuestras = new Set([ETIQUETA_ASISTENTA, etiquetaTema(tema)]);
  for (const b of bloques(fm)) {
    if (b.clave === null) {
      if (b.lineas.some((l) => l.trim() !== '')) return false;
      continue;
    }
    if (!CLAVES_NUESTRAS.has(b.clave)) return false;
    if (b.clave === 'tags' && valoresLista(b).some((t) => !nuestras.has(t))) return false;
  }
  return true;
}

/** La línea de enlaces que regenera Asistenta, o null si no hay nada que enlazar. */
export function lineaRelacionado(temas: readonly string[]): string {
  const enlaces = [...temas.map((t) => `[[${t}]]`), '[[indice|Índice]]'];
  return `Relacionado: ${enlaces.join(' · ')} ${MARCA_AUTO}`;
}

export function esLineaRelacionadoAuto(l: string): boolean {
  return RELACIONADO_AUTO.test(l);
}

/**
 * Pone (o actualiza) la línea «Relacionado» justo debajo del título `# …`. Si Nico
 * ha escrito su propia línea «Relacionado:» (sin la marca), la suya manda y no se
 * añade otra.
 */
export function fijarRelacionado(cuerpo: readonly string[], linea: string): string[] {
  const out = [...cuerpo];
  const i = out.findIndex(esLineaRelacionadoAuto);
  if (i >= 0) {
    out[i] = linea;
    return out;
  }
  if (out.some((l) => RELACIONADO_A_MANO.test(l))) return out;
  const t = out.findIndex((l) => /^#\s/.test(l));
  if (t < 0) return [linea, '', ...out];
  // `# Título`, línea en blanco, «Relacionado», línea en blanco, hechos.
  const despues = out.slice(t + 1);
  while (despues[0]?.trim() === '') despues.shift();
  return [...out.slice(0, t + 1), '', linea, '', ...despues];
}

/** Hechos de un tema en bruto, para calcular sus relaciones. */
export interface PerfilTema {
  tema: string;
  tags: string[];
  textos: string[];
}

/** Etiquetas que no dicen nada del tema (y no deben enlazar notas entre sí). */
const ETIQUETAS_VACIAS = new Set(['aprendido', 'general', 'auto', 'nota', 'hecho']);

/**
 * Con qué otros temas está relacionado `tema`: una etiqueta que es otro tema, un
 * hecho que nombra otro tema, o una etiqueta en común. Ordenado y con tope.
 */
export function temasRelacionados(
  tema: string,
  perfiles: readonly PerfilTema[],
  tope = 8,
): string[] {
  const yo = perfiles.find((p) => p.tema === tema);
  if (!yo) return [];
  const otros = perfiles.filter((p) => p.tema !== tema);
  const nombres = new Set(otros.map((p) => p.tema));
  const out = new Set<string>();
  const misTags = new Set(yo.tags.filter((t) => !ETIQUETAS_VACIAS.has(t)));
  for (const t of misTags) if (nombres.has(t)) out.add(t);
  const texto = ` ${plegarTexto(yo.textos.join(' ')).replace(/[^a-z0-9]+/g, ' ')} `;
  for (const otro of otros) {
    if (otro.tema === 'general' || otro.tema.length < 4) continue;
    if (texto.includes(` ${otro.tema.replace(/-/g, ' ')} `)) out.add(otro.tema);
    if (otro.tags.some((t) => t === tema)) out.add(otro.tema);
    if (otro.tags.some((t) => misTags.has(t) && !nombres.has(t) && t !== tema)) out.add(otro.tema);
  }
  return [...out].sort().slice(0, tope);
}

// ---------------------------------------------------------------------------
// Enlaces y enlaces inversos, leídos de los ficheros en cada llamada.

/** `[[destino]]`, `[[destino|texto]]`, `[[destino#apartado]]`, `![[incrustada]]`. */
const WIKILINK = /!?\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

export interface Enlace {
  /** Lo que va dentro de `[[ ]]`, sin apartado ni texto. */
  destino: string;
  linea: number;
  /** La línea entera (para dar contexto). */
  texto: string;
}

/** Enlaces de un texto, sin contar los que van en bloques de código. */
export function enlacesDeTexto(texto: string): Enlace[] {
  const out: Enlace[] = [];
  let enCodigo = false;
  texto.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) {
      enCodigo = !enCodigo;
      return;
    }
    if (enCodigo) return;
    const limpia = l.replace(/`[^`]*`/g, '');
    for (const m of limpia.matchAll(WIKILINK)) {
      const destino = (m[1] ?? '').trim();
      if (destino) out.push({ destino, linea: i + 1, texto: l.trim() });
    }
  });
  return out;
}

export interface NotaBoveda {
  /** Ruta relativa a la bóveda con `/`, p. ej. `notas/salud.md`. */
  ruta: string;
  /** Nombre sin `.md` (lo que se pone en `[[ ]]`). */
  nombre: string;
  aliases: string[];
  enlaces: Enlace[];
  lineas: string[];
}

export interface IndiceEnlaces {
  raiz: string;
  notas: NotaBoveda[];
  /** true si se paró en el tope de ficheros. */
  cortado: boolean;
}

/** Carpetas que no son notas: la de Obsidian, la papelera, copias de Asistenta. */
function carpetaIgnorada(nombre: string): boolean {
  return nombre.startsWith('.') || nombre.startsWith('_') || nombre === 'node_modules';
}

const TOPE_FICHEROS = 5000;
const TOPE_BYTES = 1024 * 1024;

/** Lee todas las notas .md de la bóveda (sin caché: lo que Nico cambió se ve ya). */
export function indiceEnlaces(raiz: string, tope = TOPE_FICHEROS): IndiceEnlaces {
  const notas: NotaBoveda[] = [];
  let cortado = false;
  const visitar = (dir: string, nivel: number): void => {
    if (nivel > 12 || cortado) return;
    let nombres: string[];
    try {
      nombres = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of nombres) {
      if (cortado) return;
      const p = join(dir, n);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!carpetaIgnorada(n)) visitar(p, nivel + 1);
        continue;
      }
      if (!n.toLowerCase().endsWith('.md') || st.size > TOPE_BYTES) continue;
      if (notas.length >= tope) {
        cortado = true;
        return;
      }
      let texto: string;
      try {
        texto = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      } catch {
        continue;
      }
      const lineas = texto.split(/\r?\n/);
      const { fm } = separarFrontmatter(lineas);
      const ruta = relative(raiz, p).split(sep).join('/');
      notas.push({
        ruta,
        nombre: n.slice(0, -3),
        aliases: [...(leerPropiedad(fm, 'aliases') ?? []), ...(leerPropiedad(fm, 'alias') ?? [])],
        enlaces: enlacesDeTexto(texto),
        lineas,
      });
    }
  };
  if (existsSync(raiz)) visitar(raiz, 0);
  return { raiz, notas, cortado };
}

function clave(s: string): string {
  return s.trim().replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
}

/**
 * A qué nota apunta `[[destino]]`, como Obsidian: por ruta (`notas/salud`), por
 * nombre (`salud`) o por alias. Con dos notas del mismo nombre gana la de la
 * misma carpeta que la que enlaza y, si no, la de ruta más corta.
 */
export function resolverEnlace(
  idx: IndiceEnlaces,
  destino: string,
  desde?: NotaBoveda,
): NotaBoveda | null {
  const k = clave(destino);
  if (!k) return null;
  const sinExt = (r: string): string => clave(r);
  if (k.includes('/')) {
    const exacta = idx.notas.find((n) => sinExt(n.ruta) === k);
    if (exacta) return exacta;
    const sufijo = idx.notas.filter((n) => sinExt(n.ruta).endsWith(`/${k}`));
    if (sufijo.length) return sufijo.sort((a, b) => a.ruta.length - b.ruta.length)[0] ?? null;
  }
  const porNombre = idx.notas.filter((n) => n.nombre.toLowerCase() === k);
  const candidatas = porNombre.length
    ? porNombre
    : idx.notas.filter((n) => n.aliases.some((a) => a.toLowerCase() === k));
  if (candidatas.length === 0) return null;
  const carpeta = (r: string): string => r.split('/').slice(0, -1).join('/');
  if (desde) {
    const misma = candidatas.find((n) => carpeta(n.ruta) === carpeta(desde.ruta));
    if (misma) return misma;
  }
  return [...candidatas].sort((a, b) => a.ruta.length - b.ruta.length)[0] ?? null;
}

/** Enlaces inversos: qué notas enlazan a `nota`, con la línea de cada enlace. */
export function enlacesInversos(
  idx: IndiceEnlaces,
  nota: NotaBoveda,
): Array<{ desde: NotaBoveda; enlace: Enlace }> {
  const out: Array<{ desde: NotaBoveda; enlace: Enlace }> = [];
  for (const n of idx.notas) {
    if (n === nota) continue;
    for (const e of n.enlaces) {
      if (resolverEnlace(idx, e.destino, n) === nota) out.push({ desde: n, enlace: e });
    }
  }
  return out;
}

/** Ficheros que iCloud u OneDrive duplicaron al chocar («salud 2.md», «salud (1).md»). */
export function copiasDuplicadas(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => /^[^.].*(?: \d+| \(\d+\)|-conflict[^.]*|\.sync-conflict-[^.]*)\.md$/i.test(n))
      .sort();
  } catch {
    return [];
  }
}

/** Nota que se deja en la carpeta de siempre cuando la memoria pasa a la bóveda. */
export const AVISO_MOVIDA = 'MEMORIA-EN-OBSIDIAN.txt';

export interface LlevarBoveda {
  copiados: number;
  /** null si se copió; si no, por qué no. */
  omitido: string | null;
}

function tieneFicheros(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory() ? tieneFicheros(p) : true) return true;
  }
  return false;
}

/**
 * Con PA_OBSIDIAN_VAULT recién puesto: copia la memoria de siempre a la bóveda,
 * fichero a fichero y comprobando cada uno byte a byte. Solo si la carpeta de
 * destino está vacía (nunca mezcla ni pisa nada de la bóveda). La original se
 * queda como copia, con un aviso de dónde está ahora la memoria.
 */
export function llevarMemoriaABoveda(origen: string, destino: string): LlevarBoveda {
  if (!tieneFicheros(origen)) return { copiados: 0, omitido: 'no hay memoria que llevar' };
  if (tieneFicheros(destino)) return { copiados: 0, omitido: 'la bóveda ya tiene memoria' };
  let copiados = 0;
  const copiar = (de: string, a: string): void => {
    mkdirSync(a, { recursive: true, mode: 0o700 });
    for (const n of readdirSync(de).sort()) {
      if (n === AVISO_MOVIDA || n.endsWith('.lock')) continue;
      const p = join(de, n);
      const q = join(a, n);
      if (statSync(p).isDirectory()) {
        copiar(p, q);
        continue;
      }
      copyFileSync(p, q);
      if (!readFileSync(q).equals(readFileSync(p))) {
        throw new Error(`la copia de ${p} no coincide byte a byte`);
      }
      copiados++;
    }
  };
  copiar(origen, destino);
  writeFileSync(
    join(origen, AVISO_MOVIDA),
    `Desde ${localDay()} la memoria de Asistenta está en:\n${destino}\n(PA_OBSIDIAN_VAULT). Esta carpeta se queda como copia y ya no se actualiza.\n`,
    'utf8',
  );
  return { copiados, omitido: null };
}

export interface EstadoObsidian {
  /** Carpeta de memoria en uso. */
  memoria: string;
  /** Lo pedido en PA_OBSIDIAN_VAULT (null si no está puesto). */
  pedida: string | null;
  /** Por qué no se usa lo pedido (null si se usa). */
  motivo: string | null;
  /** false con PA_OBSIDIAN=0. */
  activo: boolean;
  /** Copias duplicadas por la sincronización (de copiasDuplicadas). */
  duplicados: readonly string[];
}

/** /obsidian: cómo ver y editar la memoria en Obsidian, en el PC y gratis en el iPhone. */
export function textoObsidian(e: EstadoObsidian): string {
  const estado: string[] = [];
  if (e.pedida && e.motivo) {
    estado.push(
      `⚠️ PA_OBSIDIAN_VAULT=${e.pedida} no se usa: ${e.motivo}. Sigo con la carpeta de siempre.`,
    );
  } else if (e.pedida) {
    estado.push(`✅ Usando tu bóveda ${e.pedida}; mi memoria va en su carpeta «Asistenta».`);
  }
  if (!e.activo)
    estado.push('Ahora mismo las notas van sin propiedades ni enlaces (PA_OBSIDIAN=0).');
  if (e.duplicados.length) {
    estado.push(
      `⚠️ La sincronización ha duplicado: ${e.duplicados.slice(0, 5).join(', ')}. Lo que haya ahí no lo leo: pásalo a la nota buena y borra la copia.`,
    );
  }
  return [
    '📓 Obsidian',
    `Mi memoria ya es una bóveda de Obsidian: ${e.memoria}`,
    ...estado,
    '',
    'En el PC:',
    '1. Instala Obsidian (obsidian.md, gratis).',
    '2. «Abrir carpeta como bóveda» y elige esa carpeta.',
    '3. Empieza por «indice». Los temas están enlazados entre sí; puedes editar y escribir lo que quieras: lo respeto.',
    '',
    'En el iPhone, gratis con iCloud:',
    '1. En el PC instala iCloud para Windows y entra con tu Apple ID.',
    '2. En el iPhone abre Obsidian → «Crear bóveda», llámala Notas y activa «Guardar en iCloud».',
    '3. En el PC aparece en %USERPROFILE%\\iCloudDrive\\iCloud~md~obsidian\\Notas. Clic derecho → «Mantener siempre en este dispositivo».',
    '4. En el .env pon PA_OBSIDIAN_VAULT=esa carpeta y reinicia. Copio la memoria allí; la de ahora se queda como copia.',
    '',
    'Ojo: Obsidian avisa de que iCloud en Windows a veces duplica ficheros («salud 2.md»). Si pasa, aquí te lo digo. Obsidian Sync es de pago y no hace falta.',
  ].join('\n');
}

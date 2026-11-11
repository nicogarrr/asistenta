/**
 * Adjuntos en un correo que envía Asistenta (Grok Bot: «a draft can include files the Bot
 * prepared… If a file changed after the draft was prepared, nothing is sent»).
 *
 * - Qué se puede adjuntar: lo que Asistenta te ha hecho (la carpeta «creados»: gráficas,
 *   Excel, PDF, Word; por su id o por su nombre) y ficheros de tus carpetas de siempre
 *   (Documentos, Escritorio, Descargas) o de la carpeta de trabajo. Nada oculto (.ssh,
 *   .env…), nada de claves o certificados, nada del estado de Asistenta salvo «creados».
 * - La pregunta de aprobación enseña cada adjunto con su nombre y tamaño; lo que se
 *   aprueba es eso. Al enviar se vuelve a mirar: si un fichero ha cambiado (tamaño o fecha)
 *   desde que lo viste, no sale nada.
 * - Tope: 5 ficheros y 18 MB entre todos (Gmail corta en 25 MB y la codificación del
 *   correo engorda los adjuntos un tercio).
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { nombreSeguro } from '../creados.js';

export const ADJUNTOS_MAX = 5;
export const ADJUNTOS_MAX_BYTES = 18 * 1024 * 1024;

const CREADO_ID = /^\d{8}-\d{6}(?:-\d+)?-[A-Za-z0-9._-]{1,80}$/;
/** Claves, certificados, bóvedas y ficheros de entorno: nunca salen por correo. */
const SECRETO =
  /\.(?:env|pem|key|p12|pfx|ppk|kdbx|keychain|asc|gpg|enc|sqlite|db)$|^(?:id_[a-z0-9]+|known_hosts|authorized_keys|credentials|\.env.*)$/i;

export interface AdjuntosConfig {
  /** Carpeta «creados» (lo que Asistenta genera). */
  creadosDir: string;
  /** Carpeta de estado de Asistenta: fuera de «creados», nada sale de ahí. */
  stateDir: string;
  /** Carpetas desde las que se puede adjuntar un fichero por su ruta. */
  roots: string[];
}

export interface AdjuntoVisto {
  ok: true;
  /** Nombre con el que va en el correo. */
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}
export type Adjunto = AdjuntoVisto | { ok: false; ref: string; why: string };

let config: AdjuntosConfig | null = null;
/** Lo que se enseñó en la aprobación, por ref: si al enviar no coincide, no sale. */
const vistos = new Map<string, { size: number; mtimeMs: number; at: number }>();
/** Una aprobación sin envío (dijiste que no) no deja la foto vieja para siempre. */
const VISTO_TTL_MS = 30 * 60_000;

/** Raíces por defecto: carpeta de trabajo y Documentos/Escritorio/Descargas del usuario. */
export function raicesPorDefecto(home: string = homedir(), cwd: string = process.cwd()): string[] {
  const names = ['Documents', 'Documentos', 'Desktop', 'Escritorio', 'Downloads', 'Descargas'];
  const out = [cwd, ...names.map((n) => join(home, n))];
  // OneDrive mueve Documentos y Escritorio en Windows.
  for (const n of ['Documents', 'Documentos', 'Desktop', 'Escritorio'])
    out.push(join(home, 'OneDrive', n));
  return out;
}

export function configurarAdjuntos(next: AdjuntosConfig | null): void {
  config = next;
  vistos.clear();
}

const lower = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

function dentro(root: string, p: string): boolean {
  const rel = relative(lower(resolve(root)), lower(p));
  return rel === '' ? false : !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function fichero(path: string, name: string, ref: string): Adjunto {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, ref, why: 'no es un fichero' };
    return { ok: true, name, path, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { ok: false, ref, why: 'no existe' };
  }
}

/** Orden de un id de «creados»: «20261111-120000-2-x» → 20261111120000·100 + 2 (sin número = 1). */
function ordenCreado(id: string): number {
  const m = /^(\d{8})-(\d{6})(?:-(\d+))?-/.exec(id);
  return m ? Number(`${m[1]}${m[2]}`) * 100 + Number(m[3] ?? 1) : 0;
}

/** Un adjunto de «creados» por id exacto o por su nombre («grafica.png» = el más nuevo). */
function deCreados(cfg: AdjuntosConfig, ref: string): Adjunto | null {
  const id = basename(ref);
  if (CREADO_ID.test(id) && !/[\\/]/.test(ref))
    return fichero(join(cfg.creadosDir, id), id.replace(/^\d{8}-\d{6}(?:-\d+)?-/, ''), ref);
  if (/[\\/]/.test(ref)) return null;
  let names: string[] = [];
  try {
    names = readdirSync(cfg.creadosDir).filter((n) => CREADO_ID.test(n));
  } catch {
    return null;
  }
  // El nombre que se guardó es el «seguro» (sin tildes ni espacios): «Gastos de octubre.xlsx»
  // está en la carpeta como «Gastos-de-octubre.xlsx».
  const want = new Set([ref.trim().toLowerCase(), nombreSeguro(ref.trim()).toLowerCase()]);
  // El más nuevo: por fecha y, en el mismo segundo, por su número («-2-», «-10-»). Con
  // .sort() de texto «…-2-grafica.png» iba antes que «…-grafica.png» y salía la vieja.
  const hit = names
    .filter((n) => want.has(n.replace(/^\d{8}-\d{6}(?:-\d+)?-/, '').toLowerCase()))
    .sort((a, b) => ordenCreado(a) - ordenCreado(b) || a.localeCompare(b))
    .pop();
  return hit
    ? fichero(join(cfg.creadosDir, hit), hit.replace(/^\d{8}-\d{6}(?:-\d+)?-/, ''), ref)
    : null;
}

/** Las carpetas de siempre del usuario (no la del programa): donde se busca un nombre a secas. */
const CARPETA_USUARIO = /^(documents|documentos|desktop|escritorio|downloads|descargas)$/i;

/**
 * «Descargas/factura.pdf» o «factura.pdf» sin la ruta entera: el modelo no sabe la carpeta
 * del usuario en Windows (C:\Users\<nombre>\…) y antes eso era «dime la ruta». Se busca en
 * Documentos/Escritorio/Descargas (también las de OneDrive). Devuelve la ruta, o por qué no.
 */
function enCarpetas(cfg: AdjuntosConfig, ref: string): { path: string } | { why: string } {
  const segs = ref.split(/[\\/]+/).filter(Boolean);
  const userRoots = cfg.roots.filter((root) => CARPETA_USUARIO.test(basename(root)));
  const hits = new Map<string, string>();
  const probar = (root: string, rest: string[]) => {
    if (!rest.length) return;
    const p = resolve(root, ...rest);
    // «Documentos/../…» no sale de su carpeta.
    if (!dentro(root, p)) return;
    try {
      if (statSync(p).isFile()) hits.set(lower(real(p)), p);
    } catch {}
  };
  const first = segs[0] ?? '';
  if (segs.length > 1 && CARPETA_USUARIO.test(first)) {
    const alias = (n: string) =>
      ({ documents: 'doc', documentos: 'doc', desktop: 'esc', escritorio: 'esc' })[
        n.toLowerCase()
      ] ?? 'des';
    for (const root of userRoots)
      if (alias(basename(root)) === alias(first)) probar(root, segs.slice(1));
  } else if (segs.length === 1) {
    for (const root of userRoots) probar(root, segs);
  }
  const found = [...hits.values()];
  if (found.length === 1 && found[0]) return { path: found[0] };
  if (found.length > 1)
    return {
      why: `hay ${found.length} con ese nombre (${found.map((p) => basename(dirname(p))).join(', ')}); dime la carpeta`,
    };
  return {
    why: 'no lo encuentro entre lo que te he hecho ni en Documentos/Escritorio/Descargas; dime la ruta',
  };
}

/** Mira un adjunto (sin leerlo): dónde está, si se puede mandar y cuánto pesa. */
export function mirarAdjunto(ref: string): Adjunto {
  const cfg = config;
  const r = ref.trim();
  if (!cfg) return { ok: false, ref: r, why: 'los adjuntos no están disponibles aquí' };
  if (!r || /[\0\r\n]/.test(r)) return { ok: false, ref: r, why: 'nombre no válido' };
  const creado = deCreados(cfg, r);
  if (creado) return creado;
  let expanded = r.replace(/^~(?=$|[\\/])/, homedir());
  if (!isAbsolute(expanded)) {
    const hit = enCarpetas(cfg, expanded);
    if ('why' in hit) return { ok: false, ref: r, why: hit.why };
    expanded = hit.path;
  }
  const p = real(resolve(expanded));
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.some((s) => s.startsWith('.')))
    return { ok: false, ref: r, why: 'está en una carpeta oculta' };
  if (SECRETO.test(basename(p)))
    return { ok: false, ref: r, why: 'parece una clave o datos privados' };
  if (dentro(cfg.stateDir, p) && !dentro(cfg.creadosDir, p))
    return { ok: false, ref: r, why: 'es un fichero interno de Asistenta' };
  if (!dentro(cfg.creadosDir, p) && !cfg.roots.some((root) => dentro(real(root), p)))
    return {
      ok: false,
      ref: r,
      why: 'solo adjunto de Documentos, Escritorio, Descargas o lo que te he hecho',
    };
  return fichero(p, basename(p), r);
}

const kb = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Las líneas «Adjuntos:» de la pregunta de aprobación; recuerda lo que se enseñó. */
export function lineasAdjuntos(refs: string[], now: number = Date.now()): string {
  if (!refs.length) return '';
  const lines = refs.map((ref) => {
    const a = mirarAdjunto(ref);
    if (!a.ok) {
      vistos.delete(ref.trim());
      return `  ✗ ${a.ref}: ${a.why} (no saldría)`;
    }
    // La pregunta puede volver a pintarse (registro, reintento de la tarjeta): la foto
    // que vale es la primera, la que viste al aprobar; un cambio luego no la pisa.
    const prev = vistos.get(ref.trim());
    if (!prev || now - prev.at > VISTO_TTL_MS)
      vistos.set(ref.trim(), { size: a.size, mtimeMs: a.mtimeMs, at: now });
    return `  📎 ${a.name} (${kb(a.size)}) — ${a.path}`;
  });
  return `Adjuntos (${refs.length}):\n${lines.join('\n')}`;
}

/**
 * Lee los adjuntos para enviarlos. Falla entero (nada sale) si alguno no vale, si pasa
 * del tope o si cambió desde la aprobación.
 */
export function cargarAdjuntos(
  refs: string[],
): { ok: true; files: Array<{ filename: string; content: Buffer }> } | { ok: false; why: string } {
  if (refs.length > ADJUNTOS_MAX) return { ok: false, why: `como mucho ${ADJUNTOS_MAX} adjuntos` };
  const files: Array<{ filename: string; content: Buffer }> = [];
  let total = 0;
  const seenAll = refs.map((ref) => vistos.get(ref.trim()));
  // Se gastan al intentar el envío: el siguiente borrador vuelve a mirar los ficheros.
  for (const ref of refs) vistos.delete(ref.trim());
  for (const [i, ref] of refs.entries()) {
    const a = mirarAdjunto(ref);
    if (!a.ok) return { ok: false, why: `«${a.ref}» ${a.why}` };
    const seen = seenAll[i];
    if (!seen) return { ok: false, why: `«${a.name}» no salía en el borrador que aprobaste` };
    if (seen.size !== a.size || seen.mtimeMs !== a.mtimeMs)
      return {
        ok: false,
        why: `«${a.name}» cambió después de que aprobaras el borrador; pídemelo otra vez`,
      };
    total += a.size;
    if (total > ADJUNTOS_MAX_BYTES)
      return { ok: false, why: `los adjuntos pasan de ${kb(ADJUNTOS_MAX_BYTES)} entre todos` };
    const content = readFileSync(a.path);
    if (content.length !== a.size)
      return { ok: false, why: `«${a.name}» cambió mientras lo leía; pídemelo otra vez` };
    files.push({ filename: a.name, content });
  }
  return { ok: true, files };
}

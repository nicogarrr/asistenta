/**
 * La carpeta de memoria: un solo sitio en el PC donde vive lo que Asistenta
 * recuerda, en ficheros que Nico abre y edita con el Bloc de notas.
 *
 * Sigue el reparto del artículo «The components of agent memory» (Anthropic,
 * nov. 2026): notas escritas en el momento (salience at the source) y una
 * pasada offline («dreaming») que ordena, fecha y mantiene un índice.
 *
 *   memoria/
 *     indice.md              qué hay y dónde (lo regenera Asistenta)
 *     perfil.md              hechos sobre ti
 *     episodios/AAAA-MM-DD.md  diario: qué pasó cada día, una línea por turno
 *     procedimientos/        cómo-se-hace aprendidos (habilidades)
 *     notas/                 hechos por tema/chat
 *
 * Cada escritura va a disco al momento (append/write síncrono). Nada que
 * parezca una clave entra en un episodio, y ninguna ruta sale de la carpeta.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { looksLikeCredential } from '../memory.js';
import { sliceSafe } from '../text.js';

export const SUBCARPETAS_MEMORIA = ['episodios', 'procedimientos', 'notas'] as const;
export const INDICE_MEMORIA = 'indice.md';
export const PERFIL_MEMORIA = 'perfil.md';
/** Tope por lado de cada línea del diario: el diario resume, no transcribe. */
export const TOPE_EPISODIO = 280;
const OMITIDO = '[omitido: parecía una clave]';

/** true si `p` queda dentro de `dir` (sin salir con «..» ni rutas absolutas). */
export function dentroDeCarpeta(dir: string, p: string): boolean {
  const rel = relative(resolve(dir), resolve(dir, p));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Crea la carpeta y sus subcarpetas si faltan; escribe el índice si no existe. */
export function asegurarCarpetaMemoria(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const sub of SUBCARPETAS_MEMORIA)
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  if (!existsSync(join(dir, INDICE_MEMORIA))) escribirIndiceMemoria(dir);
}

function dosCifras(n: number): string {
  return String(n).padStart(2, '0');
}

/** AAAA-MM-DD en la hora local del PC. */
export function diaLocal(fecha: Date): string {
  return `${fecha.getFullYear()}-${dosCifras(fecha.getMonth() + 1)}-${dosCifras(fecha.getDate())}`;
}

function limpiar(texto: string): string {
  const plano = texto.replace(/\s+/g, ' ').trim();
  if (!plano) return '';
  if (looksLikeCredential(plano)) return OMITIDO;
  return plano.length > TOPE_EPISODIO ? `${sliceSafe(plano, TOPE_EPISODIO - 1)}…` : plano;
}

export interface Episodio {
  fecha: Date;
  /** Hilo o chat donde pasó (p. ej. «telegram:123»). */
  chat: string;
  pedido: string;
  respuesta: string;
}

/**
 * Añade una línea al diario del día (episodios/AAAA-MM-DD.md) y devuelve la
 * ruta. Síncrono: si Asistenta se cae justo después, la línea ya está.
 */
export function registrarEpisodio(dir: string, ep: Episodio): string | null {
  const pedido = limpiar(ep.pedido);
  const respuesta = limpiar(ep.respuesta);
  if (!pedido && !respuesta) return null;
  const dia = diaLocal(ep.fecha);
  mkdirSync(join(dir, 'episodios'), { recursive: true, mode: 0o700 });
  const file = join(dir, 'episodios', `${dia}.md`);
  const hora = `${dosCifras(ep.fecha.getHours())}:${dosCifras(ep.fecha.getMinutes())}`;
  const chat = ep.chat.replace(/[\r\n|]/g, ' ').slice(0, 60);
  const nuevo = !existsSync(file);
  const cabecera = nuevo ? `# Episodios ${dia}\n\n` : '';
  appendFileSync(
    file,
    `${cabecera}- ${hora} · ${chat} · Tú: «${pedido || '—'}» → Asistenta: «${respuesta || '—'}»\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  // Un día nuevo es un fichero nuevo: el índice lo apunta en el acto.
  if (nuevo) escribirIndiceMemoria(dir, ep.fecha);
  return file;
}

function contarMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const nombre of readdirSync(dir).sort()) {
    const p = join(dir, nombre);
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const hijo of contarMd(p)) out.push(`${nombre}/${hijo}`);
    } else if (nombre.endsWith('.md') || nombre.endsWith('.json')) out.push(nombre);
  }
  return out;
}

export interface ResumenMemoria {
  ruta: string;
  perfil: boolean;
  episodios: string[];
  procedimientos: string[];
  notas: string[];
}

export function resumenCarpetaMemoria(dir: string): ResumenMemoria {
  return {
    ruta: dir,
    perfil: existsSync(join(dir, PERFIL_MEMORIA)),
    episodios: contarMd(join(dir, 'episodios')),
    procedimientos: contarMd(join(dir, 'procedimientos')),
    notas: contarMd(join(dir, 'notas')),
  };
}

/** Texto corto para Telegram (/memoria): dónde está la carpeta y qué tiene. */
export function textoCarpetaMemoria(r: ResumenMemoria): string {
  const ultimo = r.episodios.at(-1)?.replace(/\.md$/, '');
  return [
    `📁 Carpeta de memoria: ${r.ruta}`,
    `- perfil.md: ${r.perfil ? 'sí' : 'todavía no'}`,
    `- episodios: ${r.episodios.length} día(s)${ultimo ? `, último ${ultimo}` : ''}`,
    `- procedimientos: ${r.procedimientos.length}`,
    `- notas: ${r.notas.length}`,
    'Son ficheros normales: puedes abrirlos y editarlos. El índice está en indice.md.',
  ].join('\n');
}

/** (Re)escribe indice.md con lo que hay ahora mismo en la carpeta. */
export function escribirIndiceMemoria(dir: string, ahora: Date = new Date()): string {
  const r = resumenCarpetaMemoria(dir);
  const lista = (xs: string[], carpeta: string): string =>
    xs.length
      ? `${xs
          .slice(-50)
          .map((x) => `- ${carpeta}/${x}`)
          .join('\n')}${xs.length > 50 ? `\n- … y ${xs.length - 50} más` : ''}`
      : '- (vacío)';
  const texto = [
    '# Índice de memoria de Asistenta',
    '',
    `Actualizado: ${diaLocal(ahora)}. Lo regenera Asistenta; puedes editar los demás ficheros.`,
    '',
    '## Perfil (hechos sobre ti)',
    r.perfil ? '- perfil.md' : '- (todavía no hay perfil.md)',
    '',
    '## Episodios (diario de lo que pasó)',
    lista(r.episodios, 'episodios'),
    '',
    '## Procedimientos (cómo se hace)',
    lista(r.procedimientos, 'procedimientos'),
    '',
    '## Notas (por tema)',
    lista(r.notas, 'notas'),
    '',
  ].join('\n');
  const file = join(dir, INDICE_MEMORIA);
  writeFileSync(file, texto, { encoding: 'utf8', mode: 0o600 });
  return file;
}

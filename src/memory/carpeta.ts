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
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { looksLikeCredential } from '../memory.js';
import { sliceSafe } from '../text.js';
import { ESPEJO_PERFIL } from './profile.js';

export const SUBCARPETAS_MEMORIA = ['episodios', 'procedimientos', 'notas'] as const;
export const INDICE_MEMORIA = 'indice.md';
/** El perfil (MemorySnapshot). En Windows «perfil.md» y «PERFIL.md» son el mismo fichero. */
export const PERFIL_MEMORIA = 'PERFIL.md';
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
/**
 * Qué chats van al diario (episodios/). Por defecto solo el chat privado del
 * dueño (y el panel o la consola, que son suyos): lo que se dice en un grupo no
 * acaba en un fichero de su PC sin pedirlo. `PA_MEMORY_EPISODIOS_GRUPOS=1`
 * apunta también los grupos. Sin dueño configurado, un chat privado cuenta como suyo.
 */
export function episodioPermitido(
  m: { channel: string; chatId: string; userId: string; isGroup?: boolean },
  ownerUserId: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.PA_MEMORY_EPISODIOS_GRUPOS?.trim() === '1') return true;
  if (m.isGroup === true) return false;
  if (m.channel !== 'telegram') return true;
  if (ownerUserId == null) return m.chatId === m.userId;
  const owner = String(ownerUserId);
  return m.chatId === owner && m.userId === owner;
}

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

export interface TemaNotas {
  tema: string;
  /** Hechos vigentes (las líneas `- [id] (…)` sin `superseded-by`). */
  hechos: number;
}

/**
 * Los temas de `notas/`: cada `<tema>.md` de primer nivel con cuántos hechos
 * vigentes tiene. Lo que empieza por `_` o `.` (copias, errores) no es un tema.
 */
export function temasNotas(dir: string): TemaNotas[] {
  const notas = join(dir, 'notas');
  if (!existsSync(notas)) return [];
  const out: TemaNotas[] = [];
  for (const nombre of readdirSync(notas).sort()) {
    if (!nombre.endsWith('.md') || nombre.startsWith('_') || nombre.startsWith('.')) continue;
    const p = join(notas, nombre);
    if (!statSync(p).isFile()) continue;
    let hechos = 0;
    for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (/^-\s*\[[A-Za-z0-9_-]{1,32}\]\s*\(/.test(l) && !/\(([^)]*)superseded-by:/.test(l))
        hechos++;
    }
    out.push({ tema: nombre.slice(0, -3), hechos });
  }
  return out;
}

export interface ResumenMemoria {
  ruta: string;
  /** memoria/sobre-ti.md: copia legible del perfil v2 (src/memory/profile.ts). */
  sobreTi?: boolean;
  perfil: boolean;
  episodios: string[];
  procedimientos: string[];
  notas: string[];
  temas: TemaNotas[];
}

export function resumenCarpetaMemoria(dir: string): ResumenMemoria {
  return {
    ruta: dir,
    perfil: existsSync(join(dir, PERFIL_MEMORIA)),
    sobreTi: existsSync(join(dir, ESPEJO_PERFIL)),
    episodios: contarMd(join(dir, 'episodios')),
    procedimientos: contarMd(join(dir, 'procedimientos')),
    notas: temasNotas(dir).map((t) => `${t.tema}.md`),
    temas: temasNotas(dir),
  };
}

/** Texto corto para Telegram (/memoria): dónde está la carpeta y qué tiene. */
export function textoCarpetaMemoria(r: ResumenMemoria): string {
  const ultimo = r.episodios.at(-1)?.replace(/\.md$/, '');
  return [
    `📁 Carpeta de memoria: ${r.ruta}`,
    `- PERFIL.md (hechos sobre ti): ${r.perfil ? 'sí' : 'todavía no'}`,
    ...(r.sobreTi ? [`- ${ESPEJO_PERFIL}: tu perfil, legible y al día`] : []),
    `- episodios: ${r.episodios.length} día(s)${ultimo ? `, último ${ultimo}` : ''}`,
    `- procedimientos: ${r.procedimientos.length}`,
    `- notas por tema: ${r.temas.length ? r.temas.map((t) => `${t.tema} (${t.hechos})`).join(', ') : 'ninguna todavía'}`,
    'Son ficheros normales: puedes abrirlos y editarlos. El índice está en indice.md.',
  ].join('\n');
}

/** Lo que Nico escriba debajo de esta línea del índice se conserva al regenerarlo. */
export const MARCA_INDICE_LIBRE = '%% Lo que escribas debajo de esta línea se conserva. %%';
const TITULO_INDICE = '# Índice de memoria de Asistenta';

/** Enlace de Obsidian a un fichero de la carpeta (los .json no se abren en Obsidian). */
function enlaceNota(ruta: string, texto: string): string {
  return ruta.endsWith('.md') ? `[[${ruta}|${texto}]]` : ruta;
}

/**
 * (Re)escribe indice.md con lo que hay ahora mismo en la carpeta: con propiedades
 * y enlaces [[ ]] para que en Obsidian sea la nota central. Lo que haya debajo de
 * MARCA_INDICE_LIBRE se conserva; un indice.md escrito del todo a mano (sin
 * nuestro título ni la marca) se guarda antes en indice.editado-<fecha>.md.
 */
export function escribirIndiceMemoria(dir: string, ahora: Date = new Date()): string {
  const r = resumenCarpetaMemoria(dir);
  const sinExt = (x: string): string => x.replace(/\.(md|json)$/, '');
  const lista = (xs: string[], carpeta: string): string =>
    xs.length
      ? `${xs
          .slice(-50)
          .map((x) => `- ${enlaceNota(`${carpeta}/${x}`, sinExt(x))}`)
          .join('\n')}${xs.length > 50 ? `\n- … y ${xs.length - 50} más` : ''}`
      : '- (vacío)';
  const file = join(dir, INDICE_MEMORIA);
  let libre = '';
  if (existsSync(file)) {
    const antes = readFileSync(file, 'utf8');
    const i = antes.indexOf(MARCA_INDICE_LIBRE);
    if (i >= 0) libre = antes.slice(i + MARCA_INDICE_LIBRE.length).replace(/^\r?\n/, '');
    else if (!antes.includes(TITULO_INDICE) && antes.trim() !== '') {
      const sello = ahora.toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(dir, `indice.editado-${sello}.md`), antes, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  }
  const texto = [
    '---',
    'tags:',
    '  - asistenta',
    `updated: ${diaLocal(ahora)}`,
    '---',
    TITULO_INDICE,
    '',
    `Actualizado: ${diaLocal(ahora)}. Lo regenera Asistenta; puedes editar los demás ficheros.`,
    '',
    '## Perfil (hechos sobre ti)',
    r.perfil ? `- ${enlaceNota(PERFIL_MEMORIA, 'PERFIL')}` : '- (todavía no hay PERFIL.md)',
    ...(r.sobreTi
      ? [
          `- ${enlaceNota(ESPEJO_PERFIL, sinExt(ESPEJO_PERFIL))} (copia legible del perfil, al día en cada cambio)`,
        ]
      : []),
    '',
    '## Episodios (diario de lo que pasó)',
    lista(r.episodios, 'episodios'),
    '',
    '## Procedimientos (cómo se hace)',
    lista(r.procedimientos, 'procedimientos'),
    '',
    '## Notas (por tema)',
    r.temas.length
      ? r.temas
          .map(
            (t) =>
              `- ${enlaceNota(`notas/${t.tema}.md`, t.tema)} — ${t.hechos} ${t.hechos === 1 ? 'hecho' : 'hechos'}`,
          )
          .join('\n')
      : '- (vacío)',
    '',
    MARCA_INDICE_LIBRE,
    libre,
  ].join('\n');
  writeFileSync(file, texto.endsWith('\n') ? texto : `${texto}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return file;
}

/** Días que un diario se queda suelto antes de pasar al archivo del mes. */
export const DIAS_EPISODIOS_SUELTOS = 60;

/**
 * Parte de la pasada nocturna: los diarios de más de `dias` días se juntan en
 * episodios/archivo/AAAA-MM.md (un fichero por mes) y el diario suelto se
 * borra SOLO después de comprobar que su texto está entero en el archivo.
 * Ordena sin perder nada. Devuelve cuántos días archivó.
 */
export function archivarEpisodios(
  dir: string,
  ahora: Date = new Date(),
  dias: number = DIAS_EPISODIOS_SUELTOS,
): number {
  const carpeta = join(dir, 'episodios');
  if (!existsSync(carpeta)) return 0;
  const corte = diaLocal(new Date(ahora.getTime() - dias * 86_400_000));
  let archivados = 0;
  for (const nombre of readdirSync(carpeta).sort()) {
    const m = /^(\d{4}-\d{2})-\d{2}\.md$/.exec(nombre);
    if (!m || nombre.slice(0, 10) >= corte) continue;
    const dia = join(carpeta, nombre);
    const texto = readFileSync(dia, 'utf8');
    mkdirSync(join(carpeta, 'archivo'), { recursive: true, mode: 0o700 });
    const mes = join(carpeta, 'archivo', `${m[1]}.md`);
    const bloque = `${texto.endsWith('\n') ? texto : `${texto}\n`}\n`;
    appendFileSync(mes, bloque, { encoding: 'utf8', mode: 0o600 });
    if (!readFileSync(mes, 'utf8').includes(bloque)) continue;
    unlinkSync(dia);
    archivados++;
  }
  if (archivados) escribirIndiceMemoria(dir, ahora);
  return archivados;
}

/**
 * Lo último que pasó en ESTE chat según el diario (hoy y ayer), para la nota
 * del turno: así un hilo nuevo o un reinicio no empiezan de cero. Solo las
 * líneas del mismo chat; acotado en líneas y caracteres.
 */
export function notaEpisodiosRecientes(
  dir: string,
  chat: string,
  ahora: Date = new Date(),
  maxLineas = 6,
  tope = 1200,
): string {
  const chatLimpio = chat.replace(/[\r\n|]/g, ' ').slice(0, 60);
  const marca = ` · ${chatLimpio} · `;
  const lineas: string[] = [];
  for (const d of [new Date(ahora.getTime() - 86_400_000), ahora]) {
    const f = join(dir, 'episodios', `${diaLocal(d)}.md`);
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (l.startsWith('- ') && l.includes(marca))
        lineas.push(`${l.slice(0, 2)}${diaLocal(d)} ${l.slice(2)}`);
    }
  }
  if (!lineas.length) return '';
  let out = lineas.slice(-maxLineas);
  while (out.length > 1 && out.join('\n').length > tope) out = out.slice(1);
  const cuerpo = out.join('\n').slice(0, tope);
  return `Episodios recientes de este chat (diario local memoria/episodios; para más, la acción history):\n${cuerpo}`;
}

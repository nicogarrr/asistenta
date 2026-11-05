/**
 * Páginas vivas del panel (como las «Pages» de Grok Bot): una página con nombre que
 * Asistenta crea y una rutina puede rehacer cada vez («la página de mis gastos, cada
 * mañana»), más la lista de lo que ha creado (páginas y salidas de rutinas a fichero).
 *
 * El contenido es texto con un markdown mínimo (títulos, listas, tablas, párrafos). El
 * panel no lo pinta como HTML: el servidor lo parte en bloques y el navegador los crea
 * con textContent, así que nada de lo que entre (un correo, una web) puede inyectar HTML.
 * Las páginas viven en la base de memoria local; solo el dueño las ve (panel con token).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from './core/lazy-schema.js';
import { sliceSafe } from './text.js';

export const PAGINA_MAX_CHARS = 40_000;
export const PAGINAS_MAX = 50;

export interface PaginaViva {
  slug: string;
  titulo: string;
  contenido: string;
  origen: string;
  creada: number;
  actualizada: number;
  veces: number;
}

/** «Mis gastos de noviembre» → «mis-gastos-de-noviembre». */
/** Una fila de tabla markdown: «| café | 2 € |». */
const FILA_TABLA = /^\s*\|.*\|\s*$/;
/** «café 2 €», «súper: 25,50€», «gasolina - 40 euros» → concepto e importe. */
const IMPORTE_FINAL =
  /^(.+?)\s*[:\-–—,]?\s+((?:\d+(?:[.,]\d+)?\s*(?:€|eur(?:os?)?)|€\s*\d+(?:[.,]\d+)?))$/iu;

export function slugPagina(titulo: string): string {
  return (
    titulo
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/^\s*(?:la|el|mi|mis)\s+p[aá]gina\s+(?:de\s+)?/i, '')
      .replace(/^\s*p[aá]gina\s+(?:de\s+)?/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || ''
  );
}

export class PaginasVivas {
  readonly #db: DatabaseSync;
  #ready = false;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #init(): void {
    if (this.#ready) return;
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS paginas_vivas (slug TEXT PRIMARY KEY, titulo TEXT NOT NULL, contenido TEXT NOT NULL, origen TEXT NOT NULL, creada INTEGER NOT NULL, actualizada INTEGER NOT NULL, veces INTEGER NOT NULL DEFAULT 1)',
    );
    this.#ready = true;
  }

  /** Crea la página o reemplaza su contenido. Devuelve la página o un error en castellano. */
  guardar(
    titulo: string,
    contenido: string,
    origen: string,
    now = Date.now(),
  ): PaginaViva | { error: string } {
    this.#init();
    const t = titulo.replace(/\s+/g, ' ').trim();
    const slug = slugPagina(t);
    if (!slug) return { error: 'Dime cómo se llama la página.' };
    if (!contenido.trim())
      return { error: 'La página no puede quedar vacía (para quitarla, bórrala).' };
    const body =
      contenido.length > PAGINA_MAX_CHARS
        ? `${sliceSafe(contenido, PAGINA_MAX_CHARS)}\n\n(recortada: pasaba de ${PAGINA_MAX_CHARS} caracteres)`
        : contenido;
    const old = this.ver(slug);
    if (!old) {
      const n = (this.#db.prepare('SELECT COUNT(*) AS n FROM paginas_vivas').get() as { n: number })
        .n;
      if (n >= PAGINAS_MAX)
        return { error: `Ya hay ${PAGINAS_MAX} páginas. Borra alguna antes de crear otra.` };
    }
    const shown = sliceSafe(t.replace(/^(?:la|mi)\s+p[aá]gina\s+de\s+/i, ''), 80);
    const title = shown.charAt(0).toUpperCase() + shown.slice(1);
    this.#db
      .prepare(
        'INSERT INTO paginas_vivas (slug, titulo, contenido, origen, creada, actualizada, veces) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(slug) DO UPDATE SET titulo = excluded.titulo, contenido = excluded.contenido, origen = excluded.origen, actualizada = excluded.actualizada, veces = paginas_vivas.veces + 1',
      )
      .run(slug, title, body, sliceSafe(origen, 80), now, now);
    return this.ver(slug) as PaginaViva;
  }

  /** Pone una línea (o varias) al final de la página, sin reescribirla; la crea si no existe. */
  anadir(
    titulo: string,
    linea: string,
    origen: string,
    now = Date.now(),
  ): PaginaViva | { error: string } {
    const lineas = linea
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lineas.length) return { error: 'Dime qué apunto en la página.' };
    const old = this.ver(titulo) ?? this.#parecida(titulo);
    const previo = old?.contenido.replace(/\s+$/, '') ?? '';
    // Si la página acaba en una tabla («| Concepto | Importe |»), la línea va como otra fila de
    // la tabla; antes quedaba «- café 2 €» suelto debajo, fuera de la tabla.
    const ultima = previo.split('\n').pop() ?? '';
    const columnas = FILA_TABLA.test(ultima)
      ? ultima.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length
      : 0;
    const nueva = lineas
      .map((l) => {
        if (/^(?:[-*•|#]|\d+[.)]\s)/.test(l)) return l;
        if (!columnas) return `- ${l}`;
        const importe = columnas >= 2 ? IMPORTE_FINAL.exec(l) : null;
        const celdas = importe?.[1] && importe[2] ? [importe[1], importe[2]] : [l];
        while (celdas.length < columnas) celdas.push('');
        return `| ${celdas.join(' | ')} |`.replace(/ {2}\|/g, ' |');
      })
      .join('\n');
    const body = old ? `${previo}\n${nueva}` : nueva;
    return this.guardar(old?.titulo ?? titulo, body, origen, now);
  }

  /**
   * «la página de gastos» cuando la que hay se llama «Mis gastos» (o al revés): la misma
   * página sin «mi/mis/la/el…» delante. Antes no se encontraba y se creaba otra «Gastos»
   * con una sola línea. Solo si hay exactamente una así.
   */
  #parecida(titulo: string): PaginaViva | null {
    const base = (s: string): string => s.replace(/^(?:(?:mi|mis|la|las|el|los|de|del)-)+/, '');
    const want = base(slugPagina(titulo));
    if (!want) return null;
    const hits = this.lista().filter((p) => base(p.slug) === want);
    return hits.length === 1 ? (hits[0] ?? null) : null;
  }

  ver(slugOrTitle: string): PaginaViva | null {
    this.#init();
    const slug = slugPagina(slugOrTitle) || slugOrTitle;
    const r = this.#db.prepare('SELECT * FROM paginas_vivas WHERE slug = ?').get(slug) as
      | PaginaViva
      | undefined;
    return r ? { ...r } : null;
  }

  lista(): PaginaViva[] {
    this.#init();
    return (
      this.#db
        .prepare('SELECT * FROM paginas_vivas ORDER BY actualizada DESC')
        .all() as unknown as PaginaViva[]
    ).map((r) => ({ ...r }));
  }

  borrar(slugOrTitle: string): boolean {
    this.#init();
    const slug = slugPagina(slugOrTitle) || slugOrTitle;
    return (
      Number(this.#db.prepare('DELETE FROM paginas_vivas WHERE slug = ?').run(slug).changes) > 0
    );
  }
}

/** Un bloque de la página tal y como lo pinta el panel (solo texto, nunca HTML). */
export type BloquePagina =
  | { t: 'h'; n: 1 | 2 | 3; texto: string }
  | { t: 'p'; texto: string }
  | { t: 'ul'; items: string[] }
  | { t: 'tabla'; cabecera: string[]; filas: string[][] };

const limpio = (s: string): string =>
  s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .trim();

const celdas = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => limpio(c));

/** Parte el markdown mínimo de una página en bloques. */
export function bloquesDePagina(md: string): BloquePagina[] {
  const out: BloquePagina[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: 'p', texto: limpio(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const h = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (h) {
      flush();
      out.push({ t: 'h', n: (h[1]?.length ?? 1) as 1 | 2 | 3, texto: limpio(h[2] ?? '') });
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      flush();
      const last = out[out.length - 1];
      const item = limpio(line.replace(/^\s*[-*•]\s+/, ''));
      if (last?.t === 'ul') last.items.push(item);
      else out.push({ t: 'ul', items: [item] });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows: string[] = [line];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1] ?? ''))
        rows.push(lines[++i] ?? '');
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(celdas);
      const [cabecera = [], ...filas] = cells;
      out.push({ t: 'tabla', cabecera, filas: filas.slice(0, 500) });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.slice(0, 2000);
}

export interface SalidaRutina {
  rutina: string;
  dia: string;
  bytes: number;
}

const DIR_OK = /^[A-Za-z0-9_-]{1,64}$/;
const DIA_OK = /^\d{4}-\d{2}-\d{2}$/;

/** Las salidas a fichero de las rutinas (`<estado>/salidas/<rutina>/<día>.md`), las más nuevas primero. */
export function salidasRecientes(dir: string, max = 20): SalidaRutina[] {
  const out: SalidaRutina[] = [];
  let rutinas: string[] = [];
  try {
    rutinas = readdirSync(dir).filter((n) => DIR_OK.test(n));
  } catch {
    return [];
  }
  for (const rutina of rutinas) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, rutina));
    } catch {
      continue;
    }
    for (const f of files) {
      const dia = f.replace(/\.md$/, '');
      if (!f.endsWith('.md') || !DIA_OK.test(dia)) continue;
      try {
        out.push({ rutina, dia, bytes: statSync(join(dir, rutina, f)).size });
      } catch {
        // borrada entre medias
      }
    }
  }
  return out
    .sort((a, b) => b.dia.localeCompare(a.dia) || a.rutina.localeCompare(b.rutina))
    .slice(0, max);
}

const fecha = (ms: number, timeZone?: string): string =>
  new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(ms));

/** Datos de la tarjeta «Páginas» del panel: páginas vivas y salidas de rutinas. */
export function panelPaginas(
  store: PaginasVivas,
  salidasDir: string,
  timeZone?: string,
  /** Archivos generados (gráficas, Excel, PDF…): creados.ts. */
  creados?: { lista(): Array<{ id: string; nombre: string; bytes: number; creado: number }> },
) {
  return {
    archivos: (creados?.lista() ?? []).slice(0, 20).map((f) => ({
      id: f.id,
      nombre: f.nombre,
      bytes: f.bytes,
      creado: fecha(f.creado, timeZone),
    })),
    paginas: store.lista().map((p) => ({
      id: p.slug,
      titulo: p.titulo,
      origen: p.origen,
      actualizada: fecha(p.actualizada, timeZone),
      veces: p.veces,
    })),
    salidas: salidasRecientes(salidasDir).map((s) => ({
      id: `salida~${s.rutina}~${s.dia}`,
      titulo: `${s.rutina} · ${s.dia}`,
      bytes: s.bytes,
    })),
  };
}

/** Una página (o salida de rutina) en bloques para el panel; null si no existe. */
export function panelPagina(
  store: PaginasVivas,
  salidasDir: string,
  id: string,
  timeZone?: string,
): { titulo: string; actualizada: string; origen: string; bloques: BloquePagina[] } | null {
  const salida = /^salida~([A-Za-z0-9_-]{1,64})~(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (salida) {
    const [, rutina = '', dia = ''] = salida;
    try {
      const file = join(salidasDir, rutina, `${dia}.md`);
      const text = readFileSync(file, 'utf8');
      return {
        titulo: `${rutina} · ${dia}`,
        actualizada: fecha(statSync(file).mtimeMs, timeZone),
        origen: `rutina ${rutina}`,
        bloques: bloquesDePagina(text.length > 200_000 ? sliceSafe(text, 200_000) : text),
      };
    } catch {
      return null;
    }
  }
  if (!/^[a-z0-9-]{1,60}$/.test(id)) return null;
  const p = store.ver(id);
  if (!p) return null;
  return {
    titulo: p.titulo,
    actualizada: fecha(p.actualizada, timeZone),
    origen: p.origen,
    bloques: bloquesDePagina(p.contenido),
  };
}

const Params = lazySchema(() =>
  Type.Object({
    accion: Type.Union(
      [
        Type.Literal('guardar'),
        Type.Literal('anadir'),
        Type.Literal('ver'),
        Type.Literal('lista'),
        Type.Literal('borrar'),
      ],
      {
        description:
          'guardar = crear o rehacer la página entera; anadir = poner una línea al final sin reescribirla («apunta en la página de gastos: café 2 €»); ver; lista; borrar.',
      },
    ),
    titulo: Type.Optional(
      Type.String({
        description: 'Nombre de la página, p. ej. «Mis gastos» o «Seguimiento del piso».',
      }),
    ),
    contenido: Type.Optional(
      Type.String({
        description:
          'guardar: contenido completo (reemplaza al anterior) en markdown sencillo: # títulos, - listas, tablas con |, párrafos. anadir: solo la línea nueva.',
      }),
    ),
    rutina: Type.Optional(
      Type.String({
        description: 'Si la guarda una rutina programada, su nombre (para el panel).',
      }),
    ),
  }),
);

export function createPaginaVivaTool(deps: {
  store: PaginasVivas;
  /** Solo el dueño (su chat privado o sus rutinas) crea y lee páginas. */
  allowed: () => boolean;
  now?: () => number;
}): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'pagina_viva',
    label: 'Página del panel',
    description:
      "Live pages in the owner's web panel (card «Páginas»): create or fully replace a named page with simple markdown (headings, lists, tables), append a line without rewriting it (accion anadir: «apunta en la página de gastos: café 2 €»), view, list or delete it. Use when he asks for a page, board or tracker in the panel («hazme una página con mis gastos», «un seguimiento de los pisos que he visto»). For a page that must stay up to date («que se actualice cada mañana»), save it now AND create a routine whose prompt says to rebuild it with pagina_viva (accion guardar, rutina = routine name). Local only; nothing is sent anywhere.",
    parameters: Params(),
    execute: async (_id, args) => {
      const text = (): string => {
        if (!deps.allowed())
          return 'Las páginas del panel solo están en el chat privado del dueño.';
        const store = deps.store;
        const titulo = args.titulo?.trim() ?? '';
        switch (args.accion) {
          case 'lista': {
            const all = store.lista();
            if (all.length === 0) return 'Aún no hay páginas en el panel.';
            return `Páginas del panel (${all.length}):\n${all
              .map(
                (p) =>
                  `- ${p.titulo} (${p.origen}, ${p.veces} ${p.veces === 1 ? 'versión' : 'versiones'})`,
              )
              .join('\n')}`;
          }
          case 'ver': {
            const p = titulo ? store.ver(titulo) : null;
            return p ? `# ${p.titulo}\n\n${p.contenido}` : `No hay ninguna página «${titulo}».`;
          }
          case 'borrar':
            return titulo && store.borrar(titulo)
              ? `Página «${titulo}» borrada del panel.`
              : `No hay ninguna página «${titulo}».`;
          case 'anadir': {
            const origen = args.rutina?.trim() ? `rutina ${args.rutina.trim()}` : 'chat';
            const r = store.anadir(
              titulo,
              args.contenido ?? '',
              origen,
              deps.now?.() ?? Date.now(),
            );
            if ('error' in r) return r.error;
            return r.veces === 1
              ? `Página «${r.titulo}» creada con esa línea. Está en el panel, tarjeta «Páginas».`
              : `Apuntado en «${r.titulo}».`;
          }
          case 'guardar': {
            const origen = args.rutina?.trim() ? `rutina ${args.rutina.trim()}` : 'chat';
            const r = store.guardar(
              titulo,
              args.contenido ?? '',
              origen,
              deps.now?.() ?? Date.now(),
            );
            if ('error' in r) return r.error;
            return r.veces === 1
              ? `Página «${r.titulo}» creada. Está en el panel, tarjeta «Páginas».`
              : `Página «${r.titulo}» actualizada en el panel (versión ${r.veces}).`;
          }
          default:
            return 'Acción no válida: guardar, ver, lista o borrar.';
        }
      };
      return { content: [{ type: 'text', text: text() }], details: {} };
    },
  };
}

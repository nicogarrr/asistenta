/**
 * Vigilante de errores de precio de Amazon.es: cada barrido lee unas pocas páginas de
 * listados (rotando por las categorías), guarda el precio de cada ASIN, y cuando un precio
 * queda ≤ 30 % de una referencia fiable abre la ficha para confirmarlo antes de avisar.
 *
 * Educado con Amazon: pocas páginas por barrido, pausa de varios segundos entre peticiones,
 * y ante un captcha o un 503 se para en seco y espera (30 min, 1 h, 2 h… hasta 6 h).
 * Sin red propia: `leerListado` y `leerFicha` se inyectan (cli.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AMAZON_ORIGIN,
  esBloqueoAmazon,
  type ItemListado,
  parseFicha,
  parseListado,
  urlFicha,
} from './amazon.js';
import {
  CONFIG_REGLA,
  type ConfigRegla,
  candidato,
  type Lectura,
  type Referencia,
  verificar,
} from './regla.js';

export interface Categoria {
  id: string;
  nombre: string;
  urls: string[];
}

/** id → [nombre, slug de «más vendidos», alias de búsqueda]. */
const CATALOGO: Record<string, [string, string, string]> = {
  informatica: ['Informática', 'computers', 'computers'],
  electronica: ['Electrónica', 'electronics', 'electronics'],
  electrodomesticos: ['Grandes electrodomésticos', 'appliances', 'appliances'],
  cocina: ['Hogar y cocina', 'kitchen', 'kitchen'],
  videojuegos: ['Videojuegos', 'videogames', 'videogames'],
  juguetes: ['Juguetes', 'toys', 'toys'],
  deportes: ['Deportes', 'sports', 'sporting'],
  bricolaje: ['Bricolaje', 'diy', 'diy'],
  belleza: ['Belleza', 'beauty', 'beauty'],
  bebe: ['Bebé', 'baby', 'baby'],
};

export const CATEGORIAS_POR_DEFECTO = Object.keys(CATALOGO);

function categoriaDe(id: string): Categoria | null {
  const c = CATALOGO[id];
  if (!c) return null;
  const [nombre, bs, alias] = c;
  return {
    id,
    nombre,
    urls: [
      `${AMAZON_ORIGIN}/gp/bestsellers/${bs}/`,
      `${AMAZON_ORIGIN}/gp/movers-and-shakers/${bs}/`,
      // Novedades con su tachado: los productos nuevos sin historial también cuentan.
      `${AMAZON_ORIGIN}/s?i=${alias}&s=date-desc-rank`,
    ],
  };
}

/**
 * `PA_PRECIOS_CATEGORIAS`: vacío = todas; si no, ids separados por comas («cocina,informatica»)
 * y/o enlaces de amazon.es (una búsqueda o una lista concreta). Devuelve también lo que no entendió.
 */
export function categoriasDesde(valor: string | undefined): {
  categorias: Categoria[];
  desconocidas: string[];
} {
  const partes = (valor ?? '')
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!partes.length || partes.some((p) => /^tod[oa]s$/i.test(p))) {
    return {
      categorias: CATEGORIAS_POR_DEFECTO.map((id) => categoriaDe(id) as Categoria),
      desconocidas: [],
    };
  }
  const categorias: Categoria[] = [];
  const desconocidas: string[] = [];
  for (const p of partes) {
    const norm = p
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const c = categoriaDe(norm);
    if (c) categorias.push(c);
    else if (/^https:\/\/www\.amazon\.es\//.test(p))
      categorias.push({ id: p, nombre: p.replace(AMAZON_ORIGIN, ''), urls: [p] });
    else desconocidas.push(p);
  }
  return { categorias, desconocidas };
}

export interface Respuesta {
  status: number;
  html: string;
}

export interface DepsVigilante {
  archivo: string;
  categorias: Categoria[];
  leerListado(url: string): Promise<Respuesta>;
  leerFicha(url: string): Promise<Respuesta>;
  avisar(texto: string): Promise<void>;
  now?: () => number;
  esperar?: (ms: number) => Promise<void>;
  azar?: () => number;
  cfg?: ConfigRegla;
  /** Páginas de listado por barrido (por defecto 6). */
  paginas?: number;
  /** Fichas que se abren como mucho por barrido para verificar (por defecto 3). */
  fichas?: number;
  /** Pausa entre peticiones [mín, máx] en ms (por defecto 6–12 s). */
  pausa?: [number, number];
}

interface Asin {
  t: string;
  l: [number, number][];
}

export interface Pendiente {
  asin: string;
  titulo: string;
  cents: number;
  refCents: number;
  motivo: string;
  at: number;
}

export interface Resumen {
  inicio: number;
  fin: number;
  paginas: number;
  vistos: number;
  candidatos: number;
  avisos: number;
  errores: string[];
}

export interface Estado {
  /** null = lo que diga PA_PRECIOS (encendido por defecto). */
  encendido: boolean | null;
  cursor: number;
  asins: Record<string, Asin>;
  avisados: Record<string, { cents: number; at: number }>;
  ultimo: Resumen | null;
  bloqueo: { at: number; hasta: number; veces: number } | null;
  pendientes: Pendiente[];
  avisosTotal: number;
}

const MIN = 60_000;
const HORA = 60 * MIN;
const MAX_ASINS = 5000;
const MAX_LECTURAS = 30;
/** No se repite el aviso del mismo ASIN en 7 días salvo que baje otro 10 %. */
const REAVISO_MS = 7 * 24 * HORA;

function vacio(): Estado {
  return {
    encendido: null,
    cursor: 0,
    asins: {},
    avisados: {},
    ultimo: null,
    bloqueo: null,
    pendientes: [],
    avisosTotal: 0,
  };
}

export function eurosTexto(cents: number): string {
  return `${(cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

const FUENTE: Record<Referencia['fuente'], string> = {
  historial: 'mediana de lo que he visto antes',
  'mas-bajo-reciente': '«precio más bajo reciente» de Amazon',
  recomendado: 'precio recomendado',
  antes: 'precio anterior',
};

export function textoAviso(a: {
  asin: string;
  titulo: string;
  cents: number;
  ref: Referencia;
  vendedor: string;
}): string {
  const pct = Math.round((1 - a.cents / a.ref.cents) * 100);
  return [
    '🚨 Posible error de precio en Amazon.es',
    a.titulo.slice(0, 160),
    `💶 ${eurosTexto(a.cents)} (antes ${eurosTexto(a.ref.cents)}, −${pct} %)`,
    `📏 Referencia: ${FUENTE[a.ref.fuente]}`,
    `✅ Comprobado en la ficha: nuevo, en stock, lo vende ${a.vendedor}`,
    urlFicha(a.asin),
  ].join('\n');
}

export class VigilantePrecios {
  readonly #d: DepsVigilante;
  #corriendo = false;

  constructor(deps: DepsVigilante) {
    this.#d = deps;
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  leer(): Estado {
    if (!existsSync(this.#d.archivo)) return vacio();
    try {
      return {
        ...vacio(),
        ...(JSON.parse(readFileSync(this.#d.archivo, 'utf8')) as Partial<Estado>),
      };
    } catch {
      return vacio();
    }
  }

  #guardar(e: Estado): void {
    const ids = Object.keys(e.asins);
    if (ids.length > MAX_ASINS) {
      const ultima = (id: string) => e.asins[id]?.l.at(-1)?.[0] ?? 0;
      for (const id of ids.sort((a, b) => ultima(a) - ultima(b)).slice(0, ids.length - MAX_ASINS))
        delete e.asins[id];
    }
    mkdirSync(dirname(this.#d.archivo), { recursive: true });
    const tmp = `${this.#d.archivo}.tmp`;
    writeFileSync(tmp, JSON.stringify(e));
    renameSync(tmp, this.#d.archivo);
  }

  async #pausa(): Promise<void> {
    const [a, b] = this.#d.pausa ?? [6000, 12000];
    const ms = a + Math.round((b - a) * (this.#d.azar ?? Math.random)());
    await (this.#d.esperar ?? ((x) => new Promise((r) => setTimeout(r, x))))(ms);
  }

  #bloquear(e: Estado, donde: string, errores: string[]): void {
    const veces = (e.bloqueo?.veces ?? 0) + 1;
    const now = this.#now();
    const espera = Math.min(6 * HORA, 30 * MIN * 2 ** (veces - 1));
    e.bloqueo = { at: now, hasta: now + espera, veces };
    errores.push(
      `Amazon me pidió un captcha en ${donde}; paro y vuelvo a probar en ${Math.round(espera / MIN)} min`,
    );
  }

  /** Un barrido. No lanza: los fallos quedan en el resumen y en /precios. */
  async barrer(): Promise<Resumen | null> {
    if (this.#corriendo) return null;
    this.#corriendo = true;
    try {
      return await this.#barrer();
    } finally {
      this.#corriendo = false;
    }
  }

  async #barrer(): Promise<Resumen | null> {
    const e = this.leer();
    const inicio = this.#now();
    if (e.bloqueo && inicio < e.bloqueo.hasta) return null;
    const cfg = this.#d.cfg ?? CONFIG_REGLA;
    const urls = this.#d.categorias.flatMap((c) => c.urls);
    const r: Resumen = {
      inicio,
      fin: inicio,
      paginas: 0,
      vistos: 0,
      candidatos: 0,
      avisos: 0,
      errores: [],
    };
    const porVerificar: { it: ItemListado; lecturas: Lectura[] }[] = [];
    let bloqueado = false;
    const n = Math.min(this.#d.paginas ?? 6, urls.length);
    for (let i = 0; i < n && !bloqueado; i++) {
      const url = urls[(e.cursor + i) % urls.length] as string;
      if (i > 0) await this.#pausa();
      let res: Respuesta;
      try {
        res = await this.#d.leerListado(url);
      } catch (err) {
        r.errores.push(
          `${url.replace(AMAZON_ORIGIN, '')}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (esBloqueoAmazon(res.status, res.html)) {
        this.#bloquear(e, url.replace(AMAZON_ORIGIN, ''), r.errores);
        bloqueado = true;
        break;
      }
      if (res.status >= 400) {
        r.errores.push(`${url.replace(AMAZON_ORIGIN, '')}: respuesta ${res.status}`);
        continue;
      }
      const items = parseListado(res.html);
      if (!items.length) {
        r.errores.push(`${url.replace(AMAZON_ORIGIN, '')}: no encuentro productos en la página`);
        continue;
      }
      r.paginas++;
      for (const it of items) {
        if (it.cents === null) continue;
        r.vistos++;
        const a = e.asins[it.asin] ?? { t: it.titulo, l: [] };
        const lecturas = a.l.map(([at, cents]) => ({ at, cents }));
        if (candidato(it, lecturas, cfg) && !porVerificar.some((p) => p.it.asin === it.asin)) {
          porVerificar.push({ it, lecturas });
        }
        const ult = a.l.at(-1);
        if (!ult || ult[1] !== it.cents || inicio - ult[0] > 3 * HORA) a.l.push([inicio, it.cents]);
        a.l = a.l.slice(-MAX_LECTURAS);
        a.t = it.titulo || a.t;
        e.asins[it.asin] = a;
      }
    }
    e.cursor = (e.cursor + n) % Math.max(1, urls.length);
    r.candidatos = porVerificar.length;
    // Lo más jugoso primero; como mucho `fichas` por barrido.
    porVerificar.sort(
      (x, y) => (x.it.cents ?? 0) / (x.it.refCents || 1) - (y.it.cents ?? 0) / (y.it.refCents || 1),
    );
    let abiertas = 0;
    for (const { it, lecturas } of porVerificar) {
      if (bloqueado || abiertas >= (this.#d.fichas ?? 3)) break;
      const prev = e.avisados[it.asin];
      if (prev && inicio - prev.at < REAVISO_MS && (it.cents ?? 0) > prev.cents * 0.9) continue;
      await this.#pausa();
      abiertas++;
      let res: Respuesta;
      try {
        res = await this.#d.leerFicha(urlFicha(it.asin));
      } catch (err) {
        this.#pendiente(
          e,
          it,
          lecturas,
          `no pude abrir la ficha: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (esBloqueoAmazon(res.status, res.html)) {
        this.#bloquear(e, `la ficha ${it.asin}`, r.errores);
        bloqueado = true;
        break;
      }
      const v = verificar(it, parseFicha(res.html), lecturas, cfg);
      if (!v.ok) {
        this.#pendiente(e, it, lecturas, v.motivo);
        continue;
      }
      try {
        await this.#d.avisar(
          textoAviso({
            asin: it.asin,
            titulo: it.titulo,
            cents: v.cents,
            ref: v.ref,
            vendedor: v.vendedor,
          }),
        );
        e.avisados[it.asin] = { cents: v.cents, at: inicio };
        e.avisosTotal++;
        r.avisos++;
      } catch (err) {
        r.errores.push(
          `no pude mandar el aviso de ${it.asin}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!bloqueado && r.paginas > 0) e.bloqueo = null;
    r.fin = this.#now();
    e.ultimo = r;
    this.#guardar(e);
    return r;
  }

  /** «/precios on|off»: queda guardado y manda sobre PA_PRECIOS. */
  encender(on: boolean): void {
    const e = this.leer();
    e.encendido = on;
    this.#guardar(e);
  }

  #pendiente(e: Estado, it: ItemListado, lecturas: Lectura[], motivo: string): void {
    const ref = candidato(it, lecturas, this.#d.cfg ?? CONFIG_REGLA);
    e.pendientes = [
      {
        asin: it.asin,
        titulo: it.titulo,
        cents: it.cents ?? 0,
        refCents: ref?.cents ?? 0,
        motivo,
        at: this.#now(),
      },
      ...e.pendientes.filter((p) => p.asin !== it.asin),
    ].slice(0, 10);
  }
}

function hora(ms: number, tz?: string): string {
  return new Date(ms).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  });
}

/** Texto de /precios: si está encendido, último barrido, categorías, lo visto y lo que falla. */
export function textoEstado(
  e: Estado,
  o: {
    activo: boolean;
    motivoApagado?: string;
    categorias: Categoria[];
    desconocidas?: string[];
    cadaMin: number;
    now: number;
    tz?: string;
    ratio: number;
  },
): string {
  const l: string[] = [];
  l.push(
    o.activo
      ? `🟢 Vigilante de errores de precio (Amazon.es): encendido, cada ${o.cadaMin} min`
      : `⚪ Vigilante de errores de precio (Amazon.es): apagado${o.motivoApagado ? ` (${o.motivoApagado})` : ''}`,
  );
  l.push(
    `Avisa si el precio es ≤ ${Math.round(o.ratio * 100)} % de una referencia fiable y la ficha lo confirma.`,
  );
  l.push(`Categorías: ${o.categorias.map((c) => c.nombre).join(', ') || 'ninguna'}`);
  if (o.desconocidas?.length)
    l.push(`⚠️ No entiendo estas categorías: ${o.desconocidas.join(', ')}`);
  if (e.bloqueo && o.now < e.bloqueo.hasta) {
    l.push(
      `⏸️ Amazon me puso un captcha a las ${hora(e.bloqueo.at, o.tz)}; vuelvo a probar a las ${hora(e.bloqueo.hasta, o.tz)}.`,
    );
  }
  const u = e.ultimo;
  if (!u) l.push('Todavía no ha hecho ningún barrido.');
  else {
    l.push(
      `Último barrido: ${hora(u.inicio, o.tz)} · ${u.paginas} páginas · ${u.vistos} productos · ${u.candidatos} candidatos · ${u.avisos} avisos`,
    );
    for (const x of u.errores.slice(0, 4)) l.push(`⚠️ ${x}`);
  }
  l.push(
    `Productos con historial: ${Object.keys(e.asins).length} · avisos enviados: ${e.avisosTotal}`,
  );
  if (e.pendientes.length) {
    l.push('Candidatos descartados al verificar:');
    for (const p of e.pendientes.slice(0, 3)) {
      l.push(
        `• ${p.titulo.slice(0, 60)} a ${eurosTexto(p.cents)}: ${p.motivo} — ${urlFicha(p.asin)}`,
      );
    }
  }
  l.push(o.activo ? 'Apagar: /precios off' : 'Encender: /precios on');
  return l.join('\n');
}

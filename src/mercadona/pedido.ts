/**
 * Pedido semanal de Mercadona desde la lista de la compra.
 *
 * Durante la semana la lista se llena («faltan huevos»). El día del pedido (viernes salvo
 * que diga otro) Asistenta pregunta «Tienes esto en la lista: … ¿Hago el pedido en
 * Mercadona?» con Sí/No/Editar. «Sí» busca cada cosa (API pública de búsqueda), pregunta
 * cuando hay varias parecidas, llena el carrito de SU cuenta con la API de la web dentro de
 * su pestaña, enseña precios, total y franjas, y solo con «✅ Confirmar pedido» paga en la
 * web con la tarjeta que tiene guardada en Mercadona. Nada se paga sin ese botón.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  COMPRA_CALLBACK_PREFIX,
  type CompraStore,
  type CompraView,
  compraView,
  fold,
} from '../compra.js';
import { lazySchema, Type } from '../core/lazy-schema.js';
import {
  leerSalida,
  MERCADONA_ORIGIN,
  type NavegadorMercadona,
  type ProductoApi,
  type Respuesta,
  type Transporte,
} from './api.js';
import { elegirProducto, leerPeticion, type Producto, plegar } from './elegir.js';

export const MERCA_PREFIX = `${COMPRA_CALLBACK_PREFIX}m:`;
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export interface Franja {
  id: string;
  texto: string;
}

export interface LineaPedido {
  texto: string;
  cantidad: number;
  producto?: Producto;
  opciones?: Producto[];
  /** No se encontró o dijo «ninguna»: no va en el carrito. */
  fuera?: boolean;
}

export interface EstadoPedido {
  fase: 'eligiendo' | 'franja' | 'confirmar' | 'pagando' | 'hecho' | 'cancelado' | 'error';
  lineas: LineaPedido[];
  uuid?: string;
  warehouse?: string;
  checkoutId?: string;
  total?: string;
  franjas?: Franja[];
  franja?: Franja;
  pedido?: string;
}

export interface Ajustes {
  /** 0 = domingo … 5 = viernes. */
  dia: number;
  hora: number;
  ultimoAviso?: string;
}

interface Archivo {
  ajustes: Ajustes;
  recordados: Record<string, string>;
  pedidos: Record<string, EstadoPedido>;
}

export interface MercadonaDeps {
  /** state/mercadona.json */
  archivo: string;
  chatKey: string;
  lista: CompraStore;
  /** La pestaña de tienda.mercadona.es del Chrome del dueño. */
  transporte: () => Transporte;
  buscar: (consulta: string, warehouse: string) => Promise<ProductoApi[]>;
  /** Paga en la web el checkout ya preparado; solo se llama tras «✅ Confirmar pedido». */
  pagar: (checkoutId: string, total: string) => Promise<{ pedido: string }>;
}

const AJUSTES_DEF: Ajustes = { dia: 5, hora: 10 };

function leer(path: string): Archivo {
  const vacio: Archivo = { ajustes: { ...AJUSTES_DEF }, recordados: {}, pedidos: {} };
  if (!existsSync(path)) return vacio;
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as Partial<Archivo>;
    return {
      ajustes: { ...AJUSTES_DEF, ...(d.ajustes ?? {}) },
      recordados: d.recordados ?? {},
      pedidos: d.pedidos ?? {},
    };
  } catch {
    return vacio;
  }
}

function guardar(path: string, a: Archivo): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(a, null, 2));
  renameSync(tmp, path);
}

export function leerAjustes(path: string): Ajustes {
  return leer(path).ajustes;
}

export function fijarDia(path: string, dia: number, hora?: number): Ajustes {
  const a = leer(path);
  a.ajustes = { ...a.ajustes, dia, ...(hora === undefined ? {} : { hora }) };
  guardar(path, a);
  return a.ajustes;
}

const euros = (n: number): string => `${n.toFixed(2).replace('.', ',')} €`;
const num = (s: string | undefined | null): number => {
  const n = Number(String(s ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const ok = (r: Respuesta): boolean => r.status >= 200 && r.status < 300;
function exige(r: Respuesta, que: string): Record<string, unknown> {
  if (!ok(r)) throw new Error(`Mercadona respondió ${r.status} al ${que}`);
  return (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>;
}

// ── Intenciones de texto ────────────────────────────────────────────────────────────

export type MercadonaIntent = { kind: 'pedir' } | { kind: 'dia'; dia: number; hora?: number };

export function mercadonaIntent(text: string | undefined): MercadonaIntent | null {
  if (!text || text.length > 120) return null;
  const f = fold(text.trim().replace(/\s+/g, ' '))
    .replace(/[.!¡¿?]+/g, '')
    .trim();
  const dia =
    /^(?:quiero |pon |haz )?(?:el )?pedido de mercadona (?:los |el |cada )?(domingo|lunes|martes|miercoles|jueves|viernes|sabado)s?(?: a las (\d{1,2}))?$/.exec(
      f,
    );
  if (dia?.[1]) {
    const hora = dia[2] === undefined ? undefined : Number(dia[2]);
    if (hora !== undefined && hora > 23) return null;
    return { kind: 'dia', dia: DIAS.indexOf(dia[1]), ...(hora === undefined ? {} : { hora }) };
  }
  if (
    /^(?:haz(?:me)?|prepara(?:me)?|lanza) (?:el |un )?pedido (?:de|en|a) mercadona$/.test(f) ||
    /^(?:haz|hazme) (?:la )?compra (?:en|de) mercadona$/.test(f) ||
    /^pide (?:lo de )?la lista(?: de la compra)?(?: (?:en|a) mercadona)?$/.test(f) ||
    /^pide (?:en|a) mercadona(?: lo de la lista)?$/.test(f)
  )
    return { kind: 'pedir' };
  return null;
}

export function textoAjustes(a: Ajustes): string {
  return `🛒 Te preguntaré por el pedido de Mercadona los ${DIAS_ES[a.dia]} a las ${a.hora}:00.`;
}

// ── Aviso semanal ───────────────────────────────────────────────────────────────────

function partes(now: number, tz: string): { dia: number; hora: number; fecha: string } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(now));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { dia, hora: Number(g('hour')), fecha: `${g('year')}-${g('month')}-${g('day')}` };
}

/** El aviso del día del pedido, o null si no toca (otro día, antes de la hora, ya avisado o lista vacía). */
export function avisoSemanal(
  deps: Pick<MercadonaDeps, 'archivo' | 'lista'>,
  now: number,
  tz: string,
): CompraView | null {
  const a = leer(deps.archivo);
  const p = partes(now, tz);
  if (p.dia !== a.ajustes.dia || p.hora < a.ajustes.hora || a.ajustes.ultimoAviso === p.fecha)
    return null;
  const faltan = deps.lista.list().filter((i) => !i.done);
  if (!faltan.length) return null;
  a.ajustes.ultimoAviso = p.fecha;
  guardar(deps.archivo, a);
  return {
    text: `🛒 Tienes esto en la lista: ${faltan.map((i) => i.text).join(', ')}.\n¿Hago el pedido en Mercadona?`,
    buttons: [
      { label: '✅ Sí', action: `${MERCA_PREFIX}si` },
      { label: '❌ No', action: `${MERCA_PREFIX}no` },
      { label: '✏️ Editar', action: `${MERCA_PREFIX}ed` },
    ],
  };
}

// ── El pedido ───────────────────────────────────────────────────────────────────────

const CANCELAR = { label: '❌ Cancelar', action: `${MERCA_PREFIX}x` };

function lineaTexto(l: LineaPedido): string {
  const p = l.producto;
  if (!p) return `• ${l.texto}: no lo encontré`;
  return `• ${p.nombre}${p.formato ? ` (${p.formato})` : ''} ×${l.cantidad} — ${euros(num(p.precio) * l.cantidad)}`;
}

function resumen(e: EstadoPedido): string {
  const dentro = e.lineas.filter((l) => l.producto && !l.fuera);
  const fuera = e.lineas.filter((l) => !l.producto || l.fuera);
  const out = dentro.map(lineaTexto);
  if (fuera.length) out.push(`Sin pedir: ${fuera.map((l) => l.texto).join(', ')}`);
  if (e.total) out.push(`Total: ${euros(num(e.total))}`);
  return out.join('\n');
}

async function iniciar(deps: MercadonaDeps, a: Archivo): Promise<CompraView> {
  const faltan = deps.lista.list().filter((i) => !i.done);
  if (!faltan.length)
    return { text: '🛒 La lista de la compra está vacía: no hay nada que pedir.', buttons: [] };
  const t = deps.transporte();
  const s = await t.sesion();
  if (!s.uuid) {
    return {
      text: '🔑 No hay sesión de Mercadona en el Chrome de Asistenta. Entra una vez en tienda.mercadona.es con tu cuenta (te lo explico en docs/MERCADONA.md) y pulsa Reintentar.',
      buttons: [{ label: '🔄 Reintentar', action: `${MERCA_PREFIX}si` }],
    };
  }
  const wh = s.warehouse ?? 'vlc1';
  const lineas: LineaPedido[] = [];
  for (const item of faltan) {
    const pet = leerPeticion(item.text);
    const res = await deps.buscar(pet.texto, wh);
    const el = elegirProducto(pet, res, [], a.recordados);
    const linea: LineaPedido = { texto: item.text, cantidad: pet.cantidad };
    if (el.tipo === 'ok') linea.producto = el.producto;
    else if (el.tipo === 'elegir') linea.opciones = el.opciones;
    else linea.fuera = true;
    lineas.push(linea);
  }
  const e: EstadoPedido = { fase: 'eligiendo', lineas, uuid: s.uuid, warehouse: wh };
  return seguir(deps, a, e);
}

async function seguir(deps: MercadonaDeps, a: Archivo, e: EstadoPedido): Promise<CompraView> {
  const i = e.lineas.findIndex((l) => !l.producto && !l.fuera && l.opciones?.length);
  if (i >= 0) {
    const l = e.lineas[i] as LineaPedido;
    a.pedidos[deps.chatKey] = e;
    guardar(deps.archivo, a);
    return {
      text: `🛒 ¿Qué «${l.texto}» quieres?`,
      buttons: [
        ...(l.opciones ?? []).map((p, j) => ({
          label: `${p.nombre}${p.formato ? ` · ${p.formato}` : ''} · ${euros(num(p.precio))}`.slice(
            0,
            60,
          ),
          action: `${MERCA_PREFIX}e:${i}:${j}`,
        })),
        { label: '🚫 Ninguno', action: `${MERCA_PREFIX}e:${i}:x` },
        CANCELAR,
      ],
    };
  }
  const dentro = e.lineas.filter((l) => l.producto && !l.fuera);
  if (!dentro.length) {
    e.fase = 'cancelado';
    a.pedidos[deps.chatKey] = e;
    guardar(deps.archivo, a);
    return { text: `🛒 No encontré nada de la lista en Mercadona.\n${resumen(e)}`, buttons: [] };
  }
  // Carrito de su cuenta (lo que hubiera se sustituye por la lista) → checkout → franjas.
  const t = deps.transporte();
  const base = `/customers/${e.uuid}`;
  const cart = exige(await t.llamar('GET', `${base}/cart/`), 'leer el carrito');
  const lines = dentro.map((l) => ({
    quantity: l.cantidad,
    product_id: l.producto?.id,
    sources: [],
  }));
  exige(
    await t.llamar('PUT', `${base}/cart/`, { id: cart.id, version: cart.version, lines }),
    'llenar el carrito',
  );
  const co = exige(
    await t.llamar('POST', `${base}/checkouts/`, { cart: { id: cart.id, lines } }),
    'preparar el pedido',
  );
  e.checkoutId = String(co.id ?? '');
  if (!e.checkoutId) throw new Error('Mercadona no devolvió el pedido preparado');
  const summary = (co.summary ?? {}) as { total?: string };
  e.total =
    summary.total ?? String(dentro.reduce((s, l) => s + num(l.producto?.precio) * l.cantidad, 0));
  const dirs = exige(await t.llamar('GET', `${base}/addresses/`), 'leer tu dirección');
  const dir = ((dirs.results as Array<{ id?: unknown }> | undefined) ?? [])[0];
  if (!dir?.id) throw new Error('tu cuenta de Mercadona no tiene dirección de entrega');
  const sl = exige(await t.llamar('GET', `${base}/addresses/${dir.id}/slots/`), 'leer las franjas');
  const fmt = new Intl.DateTimeFormat('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid',
  });
  const hhmm = new Intl.DateTimeFormat('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid',
  });
  e.franjas = (
    (sl.results as
      | Array<{ id: unknown; start: string; end: string; available?: boolean }>
      | undefined) ?? []
  )
    .filter((x) => x.available !== false)
    .slice(0, 6)
    .map((x) => ({
      id: String(x.id),
      texto: `${fmt.format(new Date(x.start))}–${hhmm.format(new Date(x.end))}`,
    }));
  e.fase = 'franja';
  a.pedidos[deps.chatKey] = e;
  guardar(deps.archivo, a);
  if (!e.franjas.length) {
    return {
      text: `🛒 Carrito listo en tu cuenta, pero Mercadona no tiene franjas libres ahora.\n${resumen(e)}`,
      buttons: [CANCELAR],
    };
  }
  return {
    text: `🛒 Carrito listo en tu cuenta de Mercadona:\n${resumen(e)}\n\nElige franja de entrega:`,
    buttons: [
      ...e.franjas.map((f, n) => ({ label: `🚚 ${f.texto}`, action: `${MERCA_PREFIX}f:${n}` })),
      CANCELAR,
    ],
  };
}

/** Botones del pedido (`compra:m:…`). Pagar solo ocurre con `ok` en fase «confirmar». */
export async function mercadonaPress(deps: MercadonaDeps, data: string): Promise<CompraView> {
  const accion = data.slice(MERCA_PREFIX.length);
  const a = leer(deps.archivo);
  const e = a.pedidos[deps.chatKey];
  try {
    if (accion === 'si') return await iniciar(deps, a);
    if (accion === 'no')
      return { text: '👌 Vale, esta semana no pido nada. La lista sigue ahí.', buttons: [] };
    if (accion === 'ed') {
      const v = compraView(deps.lista.list(), 'Tacha lo que no quieras y pulsa «🛒 Pedir».');
      return {
        text: v.text,
        buttons: [...v.buttons, { label: '🛒 Pedir', action: `${MERCA_PREFIX}si` }],
      };
    }
    if (accion === 'x') {
      if (e && e.fase !== 'hecho' && e.fase !== 'pagando') e.fase = 'cancelado';
      guardar(deps.archivo, a);
      return {
        text: '👌 Pedido cancelado; no se ha pagado nada. Lo que haya en el carrito de la web se queda ahí.',
        buttons: [],
      };
    }
    if (!e || e.fase === 'cancelado' || e.fase === 'hecho' || e.fase === 'error') {
      return {
        text: 'Este pedido ya no está pendiente. Di «haz el pedido de Mercadona» para empezar otro.',
        buttons: [],
      };
    }
    const elige = /^e:(\d{1,2}):(\d{1,2}|x)$/.exec(accion);
    if (elige && e.fase === 'eligiendo') {
      const l = e.lineas[Number(elige[1])];
      if (l) {
        const p = elige[2] === 'x' ? undefined : l.opciones?.[Number(elige[2])];
        if (p) {
          l.producto = p;
          a.recordados[plegar(leerPeticion(l.texto).texto)] = p.id;
        } else l.fuera = true;
      }
      return await seguir(deps, a, e);
    }
    const franja = /^f:(\d)$/.exec(accion);
    if (franja && (e.fase === 'franja' || e.fase === 'confirmar')) {
      const f = e.franjas?.[Number(franja[1])];
      if (!f) return { text: 'Esa franja ya no está.', buttons: [CANCELAR] };
      const t = deps.transporte();
      exige(
        await t.llamar('PUT', `/customers/${e.uuid}/checkouts/${e.checkoutId}/delivery-info/`, {
          slot: { id: f.id },
        }),
        'reservar la franja',
      );
      e.franja = f;
      e.fase = 'confirmar';
      guardar(deps.archivo, a);
      return {
        text: `🛒 Tu pedido de Mercadona:\n${resumen(e)}\nEntrega: ${f.texto}\n\nSe paga con la tarjeta guardada en tu cuenta de Mercadona. ¿Lo confirmo?`,
        buttons: [{ label: '✅ Confirmar pedido', action: `${MERCA_PREFIX}ok` }, CANCELAR],
      };
    }
    if (accion === 'ok') {
      if (e.fase !== 'confirmar' || !e.checkoutId || !e.total) {
        return {
          text: 'Primero elige la franja de entrega; todavía no hay nada que confirmar.',
          buttons: [CANCELAR],
        };
      }
      // Antes de pagar se marca «pagando»: un segundo toque no puede pagar dos veces.
      e.fase = 'pagando';
      guardar(deps.archivo, a);
      try {
        const r = await deps.pagar(e.checkoutId, e.total);
        e.fase = 'hecho';
        e.pedido = r.pedido;
      } catch (err) {
        e.fase = 'error';
        guardar(deps.archivo, a);
        return {
          text: `⚠️ No pude confirmar el pago: ${(err as Error).message}. Mira «Mis pedidos» en tienda.mercadona.es antes de repetir; no lo reintento solo.`,
          buttons: [],
        };
      }
      guardar(deps.archivo, a);
      for (const l of e.lineas) if (l.producto && !l.fuera) deps.lista.mark(l.texto, true);
      return {
        text: `✅ Pedido hecho en Mercadona: nº ${e.pedido} · entrega ${e.franja?.texto ?? ''} · ${euros(num(e.total))}.`,
        buttons: [],
      };
    }
    return { text: 'No entendí ese botón.', buttons: [] };
  } catch (err) {
    return {
      text: `⚠️ Mercadona: ${(err as Error).message}. No se ha pagado nada.`,
      buttons: [{ label: '🔄 Reintentar', action: `${MERCA_PREFIX}si` }],
    };
  }
}

// ── Pago en la web (solo tras «✅ Confirmar pedido») ────────────────────────────────

/** El código que corre en la pestaña: comprueba el total y pulsa el botón de hacer el pedido. */
export function codigoPago(checkoutId: string, total: string): string {
  const totalTxt = num(total).toFixed(2).replace('.', ',');
  return [
    `await page.goto(${JSON.stringify(`${MERCADONA_ORIGIN}/checkout/${encodeURIComponent(checkoutId)}`)}, { waitUntil: 'domcontentloaded' });`,
    'await page.waitForTimeout(3000);',
    "const antes = await page.locator('body').innerText();",
    `if (!antes.includes(${JSON.stringify(totalTxt)})) return '@@MERCA@@' + JSON.stringify({ error: 'el total de la web no coincide con el que confirmaste' }) + '@@MERCA@@';`,
    "await page.getByRole('button', { name: /hacer pedido|confirmar pedido|realizar pedido|finalizar pedido/i }).first().click();",
    'await page.waitForURL(/pedido|order|confirm/i, { timeout: 90000 }).catch(() => {});',
    'await page.waitForTimeout(2000);',
    "const despues = await page.locator('body').innerText();",
    'const m = /(?:pedido|n[ºo°.]+)\\s*(?:n[ºo°.]*\\s*)?(\\d{6,})/i.exec(despues);',
    "return '@@MERCA@@' + JSON.stringify(m ? { pedido: m[1] } : { error: 'la web no mostró el número de pedido' }) + '@@MERCA@@';",
  ].join('\n');
}

export function pagoEnWeb(browser: NavegadorMercadona, scope: string): MercadonaDeps['pagar'] {
  return async (checkoutId, total) => {
    const r = leerSalida((await browser.execJs(scope, codigoPago(checkoutId, total))).text) as {
      pedido?: string;
      error?: string;
    };
    if (!r.pedido) throw new Error(r.error ?? 'la web no confirmó el pedido');
    return { pedido: r.pedido };
  };
}

// ── Herramienta para el modelo: el día del pedido ───────────────────────────────────

const ToolParams = lazySchema(() =>
  Type.Object({
    accion: Type.Union([Type.Literal('ver'), Type.Literal('fijar_dia')]),
    dia: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 6, description: '0=domingo … 5=viernes, 6=sábado' }),
    ),
    hora: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
  }),
);

export function createMercadonaTool(archivo: string): AgentTool<ReturnType<typeof ToolParams>> {
  return {
    name: 'mercadona',
    label: 'Pedido de Mercadona',
    description:
      'Weekly Mercadona online order from the shopping list. `ver` tells the weekly day/hour Asistenta asks «¿Hago el pedido en Mercadona?»; `fijar_dia` changes it («el pedido de Mercadona los lunes»). The order itself (cart, slots, «✅ Confirmar pedido») runs with buttons when the owner says «haz el pedido de Mercadona»; this tool never orders or pays.',
    parameters: ToolParams(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const a =
        args.accion === 'fijar_dia' && args.dia !== undefined
          ? fijarDia(archivo, args.dia, args.hora)
          : leerAjustes(archivo);
      const text = `${textoAjustes(a)} Para pedir ya: «haz el pedido de Mercadona».`;
      return { content: [{ type: 'text', text }], details: a };
    },
  };
}

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type Browser, chromium } from 'playwright';
import { Type } from 'typebox';
import { log } from '../log.js';

/**
 * Horarios y precios de Renfe, de solo lectura.
 *
 * Existe porque el flujo genérico con el navegador fallaba en silencio: el modelo
 * rellenaba mal el autocompletado ("MadridMadrid"), no llegaba a buscar y aun así
 * contaba que había seleccionado ruta y fecha. Aquí el recorrido es determinista y
 * cada paso se comprueba; si algo no cuadra, la herramienta lo dice con el paso
 * que falló en vez de dar por buena una búsqueda que no ocurrió. No inicia sesión
 * ni compra nada: se queda en la lista de trenes.
 */
export interface RenfeTrain {
  salida: string;
  llegada: string;
  duracion: string;
  precioDesde: string | null;
  /** Tipo de tren que muestra Renfe (AVE, Avlo, Alvia...), si lo dice. */
  tipo?: string;
  /** "sin transbordo" o lo que diga Renfe sobre transbordos, si lo dice. */
  transbordos?: string;
  /** Renfe marca el tren como completo ("Tren Completo"). */
  completo?: boolean;
  /** Estaciones de salida y llegada, del detalle del trayecto de Renfe (best effort). */
  estacionSalida?: string;
  estacionLlegada?: string;
  /** Paradas intermedias, de ese mismo detalle. */
  paradas?: string[];
}

/**
 * Texto de "Detalles del trayecto": cada parada es una hora HH:MM seguida de la
 * estacion; los nombres de iconos (radio_button_checked, location_on) se ignoran.
 * Sin al menos dos paradas no se afirma nada.
 */
export function parseTripDetail(text: string): {
  estacionSalida: string;
  estacionLlegada: string;
  paradas: string[];
  horaSalida: string;
  horaLlegada: string;
} | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== 'radio_button_checked' && l !== 'location_on');
  const stops: Array<{ hora: string; estacion: string }> = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const hora = lines[i] ?? '';
    const estacion = lines[i + 1] ?? '';
    if (/^\d{2}:\d{2}$/.test(hora) && estacion && !/^\d{2}:\d{2}/.test(estacion)) {
      stops.push({ hora, estacion });
      i++;
    }
  }
  if (stops.length < 2) return null;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return null;
  return {
    estacionSalida: first.estacion,
    estacionLlegada: last.estacion,
    paradas: stops.slice(1, -1).map((s) => `${s.hora} ${s.estacion}`),
    horaSalida: first.hora,
    horaLlegada: last.hora,
  };
}

/** Etiquetas de accesibilidad de una fila de tren en la lista de resultados de Renfe. */
export interface TrainRowInfo {
  labels: string[];
  text: string;
}

/** Datos extra de una fila: lo que Renfe ya muestra y antes se tiraba. */
export function parseTrainRow(row: TrainRowInfo): {
  salida?: string;
  tipo?: string;
  transbordos?: string;
  completo: boolean;
} {
  const out: { salida?: string; tipo?: string; transbordos?: string; completo: boolean } = {
    completo: /tren completo/i.test(row.text),
  };
  for (const label of row.labels) {
    const dep = /^Tren con salida a las (\d{2}:\d{2})/.exec(label);
    if (dep) out.salida = dep[1];
    const tipo = /^Tipo de tren:\s*(.+?)\.?$/.exec(label);
    if (tipo) out.tipo = tipo[1]?.trim();
    const trans = /^Tren (sin|con) Transbordo/i.exec(label);
    if (trans) out.transbordos = `${trans[1]?.toLowerCase()} transbordo`;
  }
  return out;
}

export const SAME_LIST_STABLE_READS = 5;

export type DayVerdict =
  | { ok: true }
  | { ok: false; reason: 'unknown-day' | 'wrong-day' | 'stale-list'; message: string };

/**
 * ¿La lista que se ve es la del dia pedido? Pura para poder probarla.
 * - sin dia marcado en la barra: "desconocido", nunca se supone (ni se usa el campo
 *   oculto, que lleva la fecha pedida aunque la lista sea de otro dia);
 * - dia marcado distinto del pedido: dia equivocado;
 * - tras pulsar el dia, la lista tiene que haber cambiado respecto a la de antes: la
 *   marca cambia al instante y la lista despues;
 * - si el resumen "Viaje de Ida" dice otro dia del mes, tambien es dia equivocado.
 */
export function judgeDay(input: {
  want: string;
  pressed: string;
  fingerprint: string;
  summaryDay: string;
  clicked: boolean;
  fingerprintBefore: string;
  /** Dia que decia el resumen antes de pulsar ('' si no se pudo leer). */
  summaryBefore?: string;
  /** Lecturas seguidas con la misma lista (0 = acaba de cambiar). */
  stableReads?: number;
}): DayVerdict {
  const { want, pressed, fingerprint, summaryDay, clicked, fingerprintBefore } = input;
  const summaryBefore = input.summaryBefore ?? '';
  if (!pressed) {
    return {
      ok: false,
      reason: 'unknown-day',
      message: 'no pude saber qué día muestra Renfe (la barra de días no marca ninguno)',
    };
  }
  if (pressed !== want) {
    return {
      ok: false,
      reason: 'wrong-day',
      message: `Renfe muestra el ${pressed} en vez del ${want}`,
    };
  }
  const wantDay = String(Number(want.slice(0, 2)));
  if (summaryDay && String(Number(summaryDay)) !== wantDay) {
    return {
      ok: false,
      reason: 'wrong-day',
      message: `el resumen de Renfe dice el día ${summaryDay} y se pidió el ${wantDay}`,
    };
  }
  // Misma lista que antes solo es sospechosa si nada mas confirma el cambio: si el
  // resumen ya dice el dia pedido y antes decia otro, la lista nueva puede ser igual
  // de verdad (mismas salidas) y es valida.
  const summaryConfirms = summaryDay !== '' && summaryBefore !== '' && summaryDay !== summaryBefore;
  // El resumen puede actualizarse ANTES que la lista: "resumen nuevo + lista vieja" se
  // parece a "mismas salidas". Para aceptarlo hace falta que la lista lleve quieta
  // SAME_LIST_STABLE_READS lecturas (~1 s cada una) tras el clic.
  if (
    clicked &&
    fingerprint === fingerprintBefore &&
    summaryConfirms &&
    (input.stableReads ?? 0) < SAME_LIST_STABLE_READS
  ) {
    return {
      ok: false,
      reason: 'stale-list',
      message: 'la lista de Renfe sigue igual y aún no puedo confirmar que sea la del día pedido',
    };
  }
  if (clicked && fingerprint === fingerprintBefore && !summaryConfirms) {
    return {
      ok: false,
      reason: 'stale-list',
      message: 'la lista de trenes de Renfe no cambió tras elegir el día',
    };
  }
  if (!fingerprint) {
    return { ok: false, reason: 'stale-list', message: 'la lista de trenes está vacía o cargando' };
  }
  return { ok: true };
}

/** YYYY-MM-DD -> DD/MM/YYYY, el formato de la barra de días y de los campos ocultos de Renfe. */
export function renfeDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Extrae los trenes del texto visible de la página de resultados. */
export function parseRenfeResults(text: string): RenfeTrain[] {
  const start = text.indexOf('tuneFiltrar');
  const body = start >= 0 ? text.slice(start + 'tuneFiltrar'.length) : text;
  const re = /(\d{2}:\d{2}) h\s*\n\s*([^\n]*?(?:hora|minuto)[^\n]*)\n\s*(\d{2}:\d{2}) h/g;
  const hits: Array<{ index: number; end: number; train: RenfeTrain }> = [];
  for (let m = re.exec(body); m; m = re.exec(body)) {
    hits.push({
      index: m.index,
      end: m.index + m[0].length,
      train: {
        salida: m[1] ?? '',
        llegada: m[3] ?? '',
        duracion: (m[2] ?? '').trim(),
        precioDesde: null,
      },
    });
  }
  hits.forEach((hit, i) => {
    const chunk = body.slice(hit.end, hits[i + 1]?.index ?? body.length);
    const price = /Precio desde\s*\n?\s*(\d{1,3}(?:\.\d{3})*,\d{2}) €/.exec(chunk);
    hit.train.precioDesde = price ? `${price[1]} €` : null;
  });
  return hits.map((h) => h.train);
}

/** Fecha (YYYY-MM-DD) de un instante en Madrid. */
export function madridDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function filterAfter(trains: RenfeTrain[], after: string | undefined): RenfeTrain[] {
  if (!after) return trains;
  return trains.filter((t) => t.salida >= after);
}

export function formatTrains(trains: RenfeTrain[]): string {
  return trains
    .map((t) => {
      const route =
        t.estacionSalida && t.estacionLlegada ? ` ${t.estacionSalida} -> ${t.estacionLlegada}` : '';
      const extra = [t.tipo, t.transbordos, t.completo ? 'COMPLETO' : '']
        .filter(Boolean)
        .join(', ');
      return `${t.salida} -> ${t.llegada}${route} (${t.duracion})${t.precioDesde ? `, desde ${t.precioDesde}` : ', sin precio visible'}${extra ? ` [${extra}]` : ''}`;
    })
    .join('\n');
}

const RenfeParams = Type.Object({
  origin: Type.String({ description: 'Ciudad o estación de origen, p. ej. "Madrid".' }),
  destination: Type.String({ description: 'Ciudad o estación de destino, p. ej. "Barcelona".' }),
  date: Type.String({ description: 'Fecha de ida, YYYY-MM-DD (no puede ser pasada).' }),
  after: Type.Optional(
    Type.String({ description: 'Solo trenes que salen desde esta hora, HH:MM (24 h).' }),
  ),
  limit: Type.Optional(Type.Number({ description: 'Máximo de trenes a devolver. Por defecto 8.' })),
});

class StepError extends Error {}

/** Cómo se abre el navegador; inyectable para probar el recorrido con una página falsa. */
export interface RenfeDeps {
  launch?: () => Promise<Browser>;
}

/** El texto del usuario va dentro de una RegExp: «Madrid (Todas)» no debe ser un grupo. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ¿Existe ese día en el calendario? 2026-02-30 pasa el formato pero no existe. */
function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y ?? 0, (m ?? 0) - 1, d ?? 0));
  return at.getUTCFullYear() === y && at.getUTCMonth() + 1 === m && at.getUTCDate() === d;
}

export async function searchRenfe(
  args: {
    origin: string;
    destination: string;
    date: string;
    after?: string;
    limit?: number;
  },
  deps: RenfeDeps = {},
): Promise<{ trains: RenfeTrain[]; total: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new StepError('fecha: usa YYYY-MM-DD');
  if (!isRealDate(args.date)) throw new StepError(`fecha: el ${args.date} no existe`);
  if (args.date < madridDate(new Date())) throw new StepError(`la fecha ${args.date} ya pasó`);
  if (args.after && !/^\d{2}:\d{2}$/.test(args.after)) throw new StepError('after: usa HH:MM');

  const launch = deps.launch ?? (() => chromium.launch({ headless: true }));
  let browser: Browser;
  try {
    browser = await launch();
  } catch (err) {
    // El error de Playwright sin navegador instalado es un recuadro de varias líneas;
    // al modelo (y a Nico) le basta con el paso y el remedio.
    const msg = err instanceof Error ? err.message : String(err);
    const missing = /Executable doesn't exist|playwright install/i.test(msg);
    throw new StepError(
      missing
        ? 'paso navegador: no hay Chromium instalado para Playwright (ejecuta `npx playwright install chromium`)'
        : `paso navegador: no se pudo abrir el navegador (${msg.split('\n')[0]?.slice(0, 160)})`,
    );
  }
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20_000);
    await page.goto('https://www.renfe.com/es/es', { waitUntil: 'domcontentloaded' });
    await page
      .locator('#onetrust-reject-all-handler')
      .click({ timeout: 5_000 })
      .catch(() => {});

    for (const [id, label, text] of [
      ['origin', 'origen', args.origin],
      ['destination', 'destino', args.destination],
    ] as const) {
      const input = page.locator(`#${id}`);
      await input.fill('');
      await input.pressSequentially(text, { delay: 40 });
      const options = page.locator('li[role=option]:visible', {
        hasText: new RegExp(escapeRegExp(text.slice(0, 20)), 'i'),
      });
      try {
        await options.first().waitFor({ state: 'visible', timeout: 8_000 });
      } catch {
        throw new StepError(`paso ${label}: Renfe no mostró sugerencias para "${text}"`);
      }
      // Solo un «(TODAS)» de lo que coincide con lo tecleado, nunca el de otra ciudad.
      const all = options.filter({ hasText: /\(TODAS\)/i });
      const wanted = (await all.count()) > 0 ? all.first() : options.first();
      await wanted.click();
      const value = (await input.inputValue()).trim();
      if (!value.toLowerCase().includes(text.slice(0, 5).toLowerCase())) {
        throw new StepError(`paso ${label}: el campo quedó con "${value}", no con "${text}"`);
      }
    }

    await page.locator('#first-input').click();
    const day = await page.evaluate((target: string) => {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Madrid',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const cells = Array.from(document.querySelectorAll<HTMLElement>('.lightpick__day'));
      const hit = cells.find(
        (c) =>
          c.dataset.time &&
          fmt.format(new Date(Number(c.dataset.time))) === target &&
          !c.classList.contains('is-disabled'),
      );
      if (!hit) return false;
      hit.click();
      return true;
    }, args.date);
    if (!day) throw new StepError(`paso fecha: ${args.date} no está disponible en el calendario`);
    await page
      .getByRole('button', { name: /^Aceptar$/ })
      .click({ timeout: 3_000 })
      .catch(() => {});

    await page
      .getByRole('button', { name: /Buscar billete/i })
      .first()
      .click();
    try {
      await page.waitForURL(/venta\.renfe\.com/, { timeout: 30_000 });
      await page.getByText('Selecciona tu viaje').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(4_000);
    } catch {
      throw new StepError('paso búsqueda: Renfe no cargó la página de resultados');
    }
    // Renfe lista por defecto el dia de HOY (desde dentro de ~30 min) aunque se haya
    // pedido otra fecha: el calendario del formulario no siempre la fija. La pagina de
    // resultados dice que dia muestra, asi que se comprueba y, si no es el pedido, se
    // pulsa ese dia en la barra de dias. Nunca se devuelve la lista de otro dia.
    const want = renfeDate(args.date);
    // Lo que la pagina dice sobre el dia y sobre la lista, leido sin ningun fallback:
    // el campo oculto filtroFechaSalida lleva la fecha PEDIDA aunque la lista sea de
    // hoy, asi que no cuenta como prueba.
    const readState = () =>
      page.evaluate(() => {
        const pressed =
          document.querySelector<HTMLElement>('button.day_cell[aria-pressed=true]')?.dataset
            .celldate ?? '';
        const labels = Array.from(
          document.querySelectorAll<HTMLElement>('#listaTrenesTBodyIda .selectedTren'),
        ).map((e) => (e.innerText ?? '').replace(/\s+/g, ' ').trim());
        const m = /Viaje de Ida\s*\n\s*\p{L}+\s+(\d{1,2})\s/u.exec(document.body.innerText);
        return { pressed, fingerprint: labels.join('|'), summaryDay: m?.[1] ?? '' };
      });
    // Si el dia marcado ya es el pedido pero la lista aun esta vacia o cargando, se
    // reintenta un poco antes de dar error.
    let before = await readState();
    for (let i = 0; i < 6 && before.pressed === want && !before.fingerprint; i++) {
      await page.waitForTimeout(1_000);
      before = await readState();
    }
    let verdict = judgeDay({ want, ...before, clicked: false, fingerprintBefore: '' });
    if (!verdict.ok && verdict.reason === 'wrong-day') {
      const cell = page.locator(`button.day_cell[data-celldate="${want}"]:not(.disabledDay)`);
      if ((await cell.count()) === 0) {
        throw new StepError(
          `paso fecha: Renfe mostró el ${before.pressed} y el ${want} no está en su barra de días; no devuelvo trenes de otro día`,
        );
      }
      // La barra de dias es un carrusel: los dias lejanos existen en el DOM pero no se ven
      // hasta avanzar con la flecha "siguiente dia" (sin esto el clic caduca).
      const next = page.locator('#calendarioida .move_to_tomorrow').first();
      for (let i = 0; i < 40 && !(await cell.first().isVisible()); i++) {
        if (!(await next.isVisible().catch(() => false))) break;
        await next.click({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(250);
      }
      if (!(await cell.first().isVisible())) {
        throw new StepError(
          `paso fecha: el ${want} no se puede ver en la barra de días de Renfe; no devuelvo trenes de otro día`,
        );
      }
      await cell.first().click({ timeout: 8_000 });
      // La marca del dia cambia al instante pero la lista recarga por AJAX: se espera a
      // que la lista CAMBIE y a que se quede quieta dos lecturas seguidas.
      let last = '';
      let stable = 0;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1_000);
        const now = await readState().catch(() => null);
        if (!now) continue;
        stable = now.fingerprint === last ? stable + 1 : 0;
        last = now.fingerprint;
        verdict = judgeDay({
          want,
          ...now,
          stableReads: stable,
          clicked: true,
          fingerprintBefore: before.fingerprint,
          summaryBefore: before.summaryDay,
        });
        if (verdict.ok && stable >= 1) break;
      }
      if (!verdict.ok || stable < 1) {
        throw new StepError(
          `paso fecha: ${verdict.ok ? 'la lista de Renfe no terminó de cargar' : verdict.message}; no devuelvo trenes de otro día`,
        );
      }
    } else if (!verdict.ok) {
      throw new StepError(`paso fecha: ${verdict.message}; no devuelvo trenes de otro día`);
    }
    const text = await page.locator('body').innerText();
    const rows: TrainRowInfo[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('#listaTrenesTBodyIda .selectedTren')).map(
        (row) => ({
          labels: Array.from(row.querySelectorAll<HTMLElement>('[aria-label]')).map(
            (e) => e.getAttribute('aria-label') ?? '',
          ),
          text: row.innerText,
        }),
      ),
    );
    const trains = parseRenfeResults(text);
    // Fila i de la pagina = tren i del texto; solo se asigna si la hora de salida
    // coincide en esa posicion (dos trenes pueden salir a la misma hora).
    trains.forEach((train, i) => {
      const row = rows[i];
      if (!row) return;
      const info = parseTrainRow(row);
      if (info.salida !== train.salida) return;
      if (info.tipo) train.tipo = info.tipo;
      if (info.transbordos) train.transbordos = info.transbordos;
      if (info.completo) train.completo = true;
    });
    if (trains.length === 0) {
      throw new StepError(
        'paso resultados: la página cargó pero no hay trenes legibles (¿sin servicio ese día?)',
      );
    }
    const filtered = filterAfter(trains, args.after);
    // Estaciones: Renfe solo las da en "Ver detalles del trayecto", fila a fila. Se
    // piden solo para los trenes que se van a devolver y es best effort: si falla, el
    // tren sale sin estaciones y el texto no inventa ninguna.
    const wanted = filtered.slice(0, Math.max(1, args.limit ?? 8));
    for (const train of wanted) {
      const idx = trains.indexOf(train);
      const rowInfo = rows[idx];
      if (idx < 0 || !rowInfo || parseTrainRow(rowInfo).salida !== train.salida) continue;
      try {
        const row = page.locator('#listaTrenesTBodyIda .selectedTren').nth(idx);
        // Clicks por DOM: tras cerrar el modal anterior queda un telon que intercepta
        // los clicks reales y la segunda fila daba timeout.
        await row
          .locator('.trenes')
          .first()
          .evaluate((el: HTMLElement) => el.click());
        const link = row.getByText('Ver detalles del trayecto').first();
        // El detalle de tarifas de la fila carga por AJAX tras abrirla.
        await link.waitFor({ state: 'visible', timeout: 10_000 });
        await link.evaluate((el: HTMLElement) => el.click());
        const modal = page.locator('.modal:visible').filter({ hasText: 'Detalles del trayecto' });
        await modal.first().waitFor({ state: 'visible', timeout: 8_000 });
        const detail = parseTripDetail(await modal.first().innerText());
        // El modal debe ser el de ESTE tren: si las horas no cuadran (un modal anterior
        // aun abierto) no se asigna nada antes que dar estaciones de otro tren.
        if (detail && detail.horaSalida === train.salida && detail.horaLlegada === train.llegada) {
          train.estacionSalida = detail.estacionSalida;
          train.estacionLlegada = detail.estacionLlegada;
          train.paradas = detail.paradas;
        }
        await modal
          .first()
          .locator('.close')
          .first()
          .evaluate((el: HTMLElement) => el.click())
          .catch(() => {});
        await modal
          .first()
          .waitFor({ state: 'hidden', timeout: 5_000 })
          .catch(() => {});
      } catch (err) {
        log.warn('renfe: detalle del trayecto no disponible', {
          salida: train.salida,
          err: String(err).slice(0, 120),
        });
      }
    }
    log.info('renfe', { total: trains.length, shown: filtered.length });
    return { trains: wanted, total: trains.length };
  } finally {
    await browser.close().catch(() => {});
  }
}

export function createRenfeTool(deps: RenfeDeps = {}): AgentTool<typeof RenfeParams> {
  return {
    name: 'renfe',
    label: 'Renfe',
    description: [
      'Busca trenes en renfe.com (solo lectura): horarios, duración y precio "desde".',
      'Úsala siempre que pidan trenes de Renfe en lugar de manejar la web a mano.',
      'Pasa la fecha ya resuelta (YYYY-MM-DD) usando el bloque <now> del contexto.',
      'Si devuelve un error, cuenta al usuario el paso que falló; nunca afirmes que has buscado si no hay lista de trenes.',
    ].join(' '),
    parameters: RenfeParams,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      try {
        const { trains, total } = await searchRenfe(args, deps);
        const head = `Renfe ${args.origin} -> ${args.destination}, ${args.date}${args.after ? `, desde las ${args.after}` : ''}: ${trains.length} de ${total} trenes.`;
        const text = trains.length
          ? `${head}\n${formatTrains(trains)}`
          : `${head} Ninguno sale a esa hora o más tarde.`;
        return { content: [{ type: 'text', text }], details: { trains, total } };
      } catch (err) {
        if (err instanceof StepError) throw err;
        throw new Error(`Renfe falló: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { chromium } from 'playwright';
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
    .map(
      (t) =>
        `${t.salida} -> ${t.llegada} (${t.duracion})${t.precioDesde ? `, desde ${t.precioDesde}` : ', sin precio visible'}`,
    )
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

export async function searchRenfe(args: {
  origin: string;
  destination: string;
  date: string;
  after?: string;
  limit?: number;
}): Promise<{ trains: RenfeTrain[]; total: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new StepError('fecha: usa YYYY-MM-DD');
  if (args.date < madridDate(new Date())) throw new StepError(`la fecha ${args.date} ya pasó`);
  if (args.after && !/^\d{2}:\d{2}$/.test(args.after)) throw new StepError('after: usa HH:MM');

  const browser = await chromium.launch({ headless: true });
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
        hasText: new RegExp(text.slice(0, 20), 'i'),
      });
      try {
        await options.first().waitFor({ state: 'visible', timeout: 8_000 });
      } catch {
        throw new StepError(`paso ${label}: Renfe no mostró sugerencias para "${text}"`);
      }
      const all = page.locator('li[role=option]:visible', { hasText: /\(TODAS\)/i });
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
    const text = await page.locator('body').innerText();
    const trains = parseRenfeResults(text);
    if (trains.length === 0) {
      throw new StepError(
        'paso resultados: la página cargó pero no hay trenes legibles (¿sin servicio ese día?)',
      );
    }
    const filtered = filterAfter(trains, args.after);
    log.info('renfe', { total: trains.length, shown: filtered.length });
    return { trains: filtered.slice(0, Math.max(1, args.limit ?? 8)), total: trains.length };
  } finally {
    await browser.close().catch(() => {});
  }
}

export function createRenfeTool(): AgentTool<typeof RenfeParams> {
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
        const { trains, total } = await searchRenfe(args);
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

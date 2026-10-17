import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Config } from '../config.js';
import { log, logHost } from '../log.js';
import { paths } from '../paths.js';
import { vaultGet } from '../vault.js';
import {
  createDirectFetchBackend,
  createDuckDuckGoBackend,
  createTinyfishBackend,
} from '../web/backends.js';
import { aggregateMetrics, readMetrics, type WebBackend, WebRouter } from '../web/router.js';
import { isFetchableResolved } from './fetch.js';

/**
 * Tool `web`: busqueda y lectura web enrutadas (idea de treg, hecha en casa).
 *
 * El enrutador elige entre backends gratuitos con fallback automatico, tope €0
 * (si no hay gratis, falla en claro y NUNCA cobra) y medida por peticion en
 * <state>/log/web-metrics.jsonl. La puerta SSRF es la misma que la tool fetch.
 *
 * Clave TinyFish (opcional): `pa vault set web:tinyfishApiKey` (Search y Fetch
 * son gratis siempre en TinyFish). Sin clave: fetch va por `directo` y search
 * cae a `ddg`; si tampoco hay, error claro.
 */

export const TINYFISH_VAULT_KEY = 'web:tinyfishApiKey';

const WebParams = Type.Object({
  action: Type.Union([Type.Literal('search'), Type.Literal('fetch'), Type.Literal('stats')], {
    description: 'search: buscar en la web; fetch: leer una URL; stats: medicion del enrutador.',
  }),
  query: Type.Optional(Type.String({ description: 'search: lo que hay que buscar.' })),
  url: Type.Optional(Type.String({ description: 'fetch: URL http(s) publica a leer.' })),
  maxResults: Type.Optional(
    Type.Number({ description: 'search: maximo de resultados (defecto 8).' }),
  ),
  maxChars: Type.Optional(
    Type.Number({ description: 'fetch: recorta el texto a este numero de caracteres.' }),
  ),
});

function text(t: string): {
  content: { type: 'text'; text: string }[];
  details: Record<string, never>;
} {
  return { content: [{ type: 'text', text: t }], details: {} };
}

/** Lista de backends en orden: directo primero (local, sin limites), TinyFish si hay clave, ddg al final. */
export async function buildWebBackends(
  getKey: (key: string) => Promise<string | undefined> = vaultGet,
): Promise<WebBackend[]> {
  const backends: WebBackend[] = [createDirectFetchBackend()];
  const key = (await getKey(TINYFISH_VAULT_KEY).catch(() => undefined))?.trim();
  if (key) {
    backends.push(createTinyfishBackend({ apiKey: key }));
  }
  backends.push(createDuckDuckGoBackend());
  return backends;
}

export function createWebTool(
  config: Pick<Config, 'webMaxCostEur'>,
  deps: {
    buildBackends?: () => Promise<WebBackend[]>;
    metricsPath?: string;
  } = {},
): AgentTool<typeof WebParams> {
  const metricsPath = deps.metricsPath ?? paths.webMetrics;
  const buildBackends = deps.buildBackends ?? (() => buildWebBackends());

  return {
    name: 'web',
    label: 'Web',
    description:
      'Busca en la web o lee una URL con el enrutador propio: varios backends declarados gratis con fallback automatico, tope de coste (por defecto 0 €: un backend declarado con coste nunca se llama) y medicion por peticion. Usa search para buscar, fetch para leer una pagina concreta y stats para ver la medicion.',
    parameters: WebParams,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const router = new WebRouter({
        backends: await buildBackends(),
        maxCostEur: config.webMaxCostEur,
        metricsPath,
      });

      if (args.action === 'search') {
        const query = args.query?.trim();
        if (!query) throw new Error('web search: falta "query" (que busco).');
        const routed = await router.routeSearch(query, { maxResults: args.maxResults ?? 8 });
        log.info('web search', { via: routed.via, items: routed.result.items.length });
        const lines = routed.result.items.map(
          (it, i) => `${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`,
        );
        return {
          ...text(
            `Busqueda: ${query} (via ${routed.via}, tope €0)\n\n<web_results query="${query.replace(/"/g, "'")}" backend="${routed.via}">\n${lines.join('\n')}\n</web_results>`,
          ),
          details: {
            via: routed.via,
            items: routed.result.items.length,
            attempts: routed.attempts,
          },
        };
      }

      if (args.action === 'fetch') {
        const url = args.url?.trim();
        if (!url) throw new Error('web fetch: falta "url".');
        // Puerta SSRF ANTES de llamar a cualquier backend: el fetch directo la
        // repite por dentro, pero un backend remoto (tinyfish) tambien la exige.
        if (!(await isFetchableResolved(url))) {
          throw new Error(
            `me niego a leer ${url}: solo URLs http(s) publicas, nada de direcciones locales o privadas`,
          );
        }
        const routed = await router.routeFetch(url, {
          maxChars: args.maxChars ?? 20_000,
          host: logHost(url),
        });
        log.info('web fetch', { via: routed.via, host: logHost(url), chars: routed.result.chars });
        return {
          ...text(
            `Leido ${url} (via ${routed.via}, tope €0)\n\n<fetched_content source="${url}" backend="${routed.via}">\n${routed.result.text}\n</fetched_content>`,
          ),
          details: {
            url,
            via: routed.via,
            chars: routed.result.chars,
            status: routed.result.status,
            attempts: routed.attempts,
          },
        };
      }

      // stats
      const metrics = await readMetrics(metricsPath);
      const stats = aggregateMetrics(metrics);
      if (stats.length === 0) {
        return text(
          'Todavia no hay medicion del enrutador web. Se registra una linea por peticion en cuanto uses web search o web fetch.',
        );
      }
      const rows = stats.map(
        (s) =>
          `- ${s.op} via ${s.backend}: ${s.calls} llamadas, ${s.okPct}% ok, p50 ${s.p50Ms} ms, p95 ${s.p95Ms} ms, ${s.totalChars} chars (~${s.totalEstTokens} tokens), coste declarado ${s.totalCostEur} €`,
      );
      const totalDeclarado = stats.reduce((s, x) => s + x.totalCostEur, 0);
      return {
        ...text(
          `Medicion del enrutador web (${metrics.length} intentos registrados):\n${rows.join('\n')}\n\nTope de coste configurado: ${config.webMaxCostEur} € (solo se llaman backends declarados a coste <= tope). Coste declarado total: ${totalDeclarado} €.`,
        ),
        details: { stats },
      };
    },
  };
}

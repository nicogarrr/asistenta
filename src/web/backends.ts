import { fetchPage } from '../tools/fetch.js';
import type { WebBackend, WebFetchResult, WebSearchItem, WebSearchResult } from './router.js';

/**
 * Backends gratuitos del enrutador web. Cada uno declara coste 0; el router
 * (router.ts) vuelve a comprobarlo antes de llamar (tope €0 fail-closed).
 *
 * - `directo`: la lectura directa de siempre (misma puerta SSRF que la tool
 *   fetch, ver tools/fetch.ts). Sin limites ni clave.
 * - `tinyfish`: Search + Fetch API de TinyFish, gratuitas siempre (no tocan el
 *   wallet; fuente: https://www.tinyfish.ai/pricing y
 *   https://docs.tinyfish.ai/search-api — 17-oct-2026). Requiere clave en el
 *   vault (web:tinyfishApiKey); sin clave el backend no se registra.
 * - `ddg`: busqueda HTML de DuckDuckGo sin clave, ultimo fallback de busqueda.
 */

/** HTTP inyectable para tests; en produccion es fetch de Node. */
export type HttpGet = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

const defaultGet: HttpGet = (url, init) => fetch(url, init);
const defaultPost: HttpPost = (url, init) => fetch(url, init);

export function createDirectFetchBackend(): WebBackend {
  return {
    id: 'directo',
    ops: ['fetch'],
    costPerCallEur: 0,
    fetch: async (url, opts): Promise<WebFetchResult> => {
      const page = await fetchPage(url, { format: 'markdown', maxChars: opts.maxChars });
      return { text: page.text, chars: page.chars, status: page.status };
    },
  };
}

const TINYFISH_SEARCH_URL = 'https://api.search.tinyfish.ai/';
const TINYFISH_FETCH_URL = 'https://api.fetch.tinyfish.ai/';

export function createTinyfishBackend(opts: {
  apiKey: string;
  httpGet?: HttpGet;
  httpPost?: HttpPost;
  timeoutMs?: number;
}): WebBackend {
  const httpGet = opts.httpGet ?? defaultGet;
  const httpPost = opts.httpPost ?? defaultPost;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const headers = {
    'X-API-Key': opts.apiKey,
    Accept: 'application/json',
  };

  return {
    id: 'tinyfish',
    ops: ['search', 'fetch'],
    // Search y Fetch son gratis siempre en TinyFish (no descuentan del wallet).
    // Si algun dia cambiaran, el tope €0 del router corta antes de gastar.
    costPerCallEur: 0,
    search: async (query, { maxResults }): Promise<WebSearchResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // La API no admite "cuantos resultados": pagina con `page` y devuelve
        // su tanda; recortamos en cliente al maxResults pedido.
        const params = new URLSearchParams({
          query,
          language: 'es',
          location: 'ES',
        });
        const res = await httpGet(`${TINYFISH_SEARCH_URL}?${params}`, {
          headers,
          signal: controller.signal,
        });
        if (res.status !== 200) {
          throw new Error(`tinyfish search HTTP ${res.status}`);
        }
        const parsed = JSON.parse(await res.text()) as {
          results?: Array<{ title?: string; url?: string; snippet?: string; site_name?: string }>;
        };
        const items: WebSearchItem[] = (parsed.results ?? [])
          .filter((r) => r.title && r.url)
          .slice(0, maxResults)
          .map((r) => ({
            title: r.title as string,
            url: r.url as string,
            snippet: r.snippet ?? '',
            siteName: r.site_name,
          }));
        return {
          items,
          chars: items.reduce((s, i) => s + i.title.length + i.snippet.length, 0),
        };
      } finally {
        clearTimeout(timer);
      }
    },
    fetch: async (url, { maxChars }): Promise<WebFetchResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await httpPost(TINYFISH_FETCH_URL, {
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: [url], format: 'markdown' }),
          signal: controller.signal,
        });
        if (res.status !== 200) {
          throw new Error(`tinyfish fetch HTTP ${res.status}`);
        }
        const parsed = JSON.parse(await res.text()) as {
          results?: Array<{ url?: string; status?: number; content?: unknown; text?: unknown }>;
          errors?: Array<{ url?: string; error?: string }>;
        };
        const first = parsed.results?.[0];
        // El contrato es `text` (string en markdown/html, objeto en json);
        // `content` se acepta por tolerancia. Null = extraccion fallida.
        const raw = first?.text ?? first?.content ?? '';
        const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (!content) {
          const code = parsed.errors?.[0]?.error ?? 'sin contenido';
          throw new Error(`tinyfish fetch: ${code}`);
        }
        const truncated = content.length > maxChars;
        const text = truncated
          ? `${content.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars]`
          : content;
        return { text, chars: content.length, status: first?.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';

export function createDuckDuckGoBackend(
  opts: { httpGet?: HttpGet; timeoutMs?: number } = {},
): WebBackend {
  const httpGet = opts.httpGet ?? defaultGet;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    id: 'ddg',
    ops: ['search'],
    costPerCallEur: 0,
    search: async (query, { maxResults }): Promise<WebSearchResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const params = new URLSearchParams({ q: query, kl: 'es-es' });
        const res = await httpGet(`${DDG_HTML_URL}?${params}`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          },
          signal: controller.signal,
        });
        if (res.status !== 200) {
          throw new Error(`ddg HTTP ${res.status}`);
        }
        const html = await res.text();
        const items = parseDuckDuckGoHtml(html).slice(0, maxResults);
        return {
          items,
          chars: items.reduce((s, i) => s + i.title.length + i.snippet.length, 0),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Parser del HTML de duckduckgo.com/html: enlaces result__a + snippets result__snippet. */
export function parseDuckDuckGoHtml(html: string): WebSearchItem[] {
  const items: WebSearchItem[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*results_links[^"]*"/i).slice(1);
  for (const block of blocks) {
    const linkMatch =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const rawHref = linkMatch[1] ?? '';
    const uddg = /[?&]uddg=([^&]+)/.exec(rawHref);
    const url = uddg?.[1] ? decodeURIComponent(uddg[1]) : rawHref;
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(linkMatch[2] ?? '');
    const snippetMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
      block,
    );
    const snippet = stripTags(snippetMatch?.[1] ?? '');
    items.push({ title, url, snippet });
  }
  return items;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

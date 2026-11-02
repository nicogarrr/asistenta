/**
 * Resultados de la búsqueda universal de la tele (com.webos.service.unifiedsearch).
 *
 * La forma REAL de la respuesta (webOS LS2, docs webosose.org y luna-send en teles
 * rooteadas) anida cada resultado un nivel más de lo obvio:
 *
 *   { "results": [ { "items": [ {
 *       "intent": { "action": "view", "uri": "app://com.webos.app.avn.settings/Settings/Profiles" },
 *       "display": { "title": "Profiles", "icon": "..." }
 *   } ], "categoryId": "com.webos.app.avn.settings" } ], "returnValue": true }
 *
 * El título vive en `display.title` y lo lanzable en el HERMANO `intent`
 * (`name` = appId, o `uri` = "app://<appId>/<ruta>"; las apps también pueden
 * contestar con intent.name sin uri). Por eso el extractor mira ambos lados:
 * sin esto salían los títulos pero sin el appId/id que `action=launch`
 * necesita para abrir el resultado SIN tocar la pantalla (vía 2 del orden de
 * búsqueda, #1909).
 */

/** Un resultado accionable de la búsqueda universal de la tele. */
export interface TvSearchItem {
  title: string;
  appId?: string;
  id?: string;
  target?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** appId desde una uri "app://<appId>/<ruta...>" (o "app://<appId>"). */
function appIdFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const m = /^app:\/\/([^/]+)/.exec(uri.trim());
  return m?.[1] || undefined;
}

/**
 * Extrae hasta 8 resultados accionables, tolerante con variantes: título en
 * title/name/label o display.title; appId en appId/launchPointId/app_id o
 * intent.name o la uri app:// del intent; id en id/contentId/content_id;
 * target en target/uri/url o intent.uri.
 */
export function collectTvSearchItems(raw: unknown): TvSearchItem[] {
  const out: TvSearchItem[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (out.length >= 8 || depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    const display =
      rec.display && typeof rec.display === 'object'
        ? (rec.display as Record<string, unknown>)
        : undefined;
    const intent =
      rec.intent && typeof rec.intent === 'object'
        ? (rec.intent as Record<string, unknown>)
        : undefined;
    const intentUri = str(intent?.uri);
    const title = str(rec.title) ?? str(rec.name) ?? str(rec.label) ?? str(display?.title);
    if (title) {
      const item: TvSearchItem = {
        title,
        appId:
          str(rec.appId) ??
          str(rec.launchPointId) ??
          str(rec.app_id) ??
          str(intent?.name) ??
          appIdFromUri(intentUri),
        id: str(rec.id) ?? str(rec.contentId) ?? str(rec.content_id),
        target: str(rec.target) ?? str(rec.uri) ?? str(rec.url) ?? intentUri,
      };
      const key = `${item.title}|${item.appId ?? ''}|${item.id ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
      return;
    }
    for (const value of Object.values(rec)) walk(value, depth + 1);
  };
  walk(raw, 0);
  return out;
}

/** Texto de action=search: lista numerada lista para launch, o el JSON crudo si no hay nada reconocible. */
export function formatTvSearchResults(key: string, raw: unknown): string {
  const items = collectTvSearchItems(raw);
  if (!items.length) {
    const fallback = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 0).slice(0, 4000);
    return (
      `Búsqueda universal de la tele para «${key}»: sin resultados reconocibles (${fallback || 'respuesta vacía'}). ` +
      'Prueba la vía 2 (launch con contentId, si conoces el título exacto) o la 3 (buscador de la app), SIN PREGUNTAR.'
    );
  }
  const lines = items.map((item, i) => {
    const bits: string[] = [];
    if (item.appId) bits.push(`appId=${item.appId}`);
    if (item.id) bits.push(`id=${item.id}`);
    if (!item.appId && item.target) bits.push(`target=${item.target}`);
    return `${i + 1}. ${item.title}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  });
  return (
    `Búsqueda universal de la tele para «${key}»:\n${lines.join('\n')}\n` +
    'Si alguno es lo que pedía el usuario, ábrelo YA con action=launch y ese appId (y contentId=<id> si aparece). ' +
    'Si ninguno vale, prueba la vía 2 o la 3, SIN PREGUNTAR.'
  );
}

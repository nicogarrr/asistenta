/**
 * Histórico de precios externo de amazon.es (camelcamelcamel), solo para confirmar un candidato:
 * nunca durante el barrido. Nico (6-nov-2026): «60 % vale siempre que el histórico sea real, que
 * no sea un falso 60 %». El «Recomendado»/PVP solo no es un precio al que se haya vendido.
 *
 * Página real (es.camelcamelcamel.com/product/B0BTJD6LCL, 6-nov-2026): tabla «Price Type | Lowest
 * Ever | Highest Ever | Current | Average» con filas `data-field="amazon"`, `"new"` y `"used"`.
 */

export interface HistorialExterno {
  fuente: 'camelcamelcamel';
  /** Fila usada: lo que vende Amazon o, si no hay, terceros nuevo. */
  campo: 'amazon' | 'new';
  minimo: number | null;
  maximo: number | null;
  actual: number | null;
  media: number | null;
}

export function urlCamel(asin: string): string {
  return `https://es.camelcamelcamel.com/product/${encodeURIComponent(asin)}`;
}

function eurosEnCeldas(fila: string): (number | null)[] {
  return [...fila.matchAll(/<td(?![^>]*class="fixed)[^>]*>([\s\S]*?)<\/td>/g)].map((m) => {
    const t = (m[1] ?? '').replace(/<small[\s\S]*?<\/small>/g, '').replace(/<[^>]+>/g, ' ');
    const n = /(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+(?:,\d{2})?)\s*€/.exec(t)?.[1];
    if (!n) return null;
    const v = Number(n.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  });
}

/** Mínimo, máximo, actual y media de la fila de Amazon (o de terceros nuevo) en céntimos. */
export function parseCamel(html: string): HistorialExterno | null {
  for (const campo of ['amazon', 'new'] as const) {
    const m = new RegExp(`<tr[^>]*data-field="${campo}"[^>]*>([\\s\\S]*?)<\\/tr>`).exec(html);
    if (!m) continue;
    const [minimo = null, maximo = null, actual = null, media = null] = eurosEnCeldas(m[1] ?? '');
    if (media === null && minimo === null) continue;
    return { fuente: 'camelcamelcamel', campo, minimo, maximo, actual, media };
  }
  return null;
}

/**
 * Lo que se ve de un fallo de voz en /conversacion y en el aviso de cierre.
 *
 * Antes salía el texto crudo del error («fetch failed», «spawn whisper ENOENT»,
 * rutas, códigos en inglés). Aquí se cambia por una frase corta en castellano;
 * el texto crudo se queda solo en el registro. Los mensajes que ya escribimos
 * en castellano (sin rastro técnico) pasan tal cual.
 */

const TECHNICAL = [
  /\bE[A-Z]{3,}\b/, // ENOENT, ECONNRESET, EACCES…
  /\b(error|failed|fetch|cannot|can't|not found|denied|timeout|timed out|invalid|unexpected|undefined|null|status|spawn|exit code|socket|unauthori[sz]ed|forbidden|quota|overloaded|unavailable)\b/i,
  /\b[1-5]\d\d\b/, // códigos HTTP
  /[A-Za-z]:\\|\/[\w.-]+\//, // rutas
  /https?:\/\//,
  /\n\s+at\s/, // pila
];

const RULES: [RegExp, string][] = [
  [
    /invalid api key|unauthori[sz]ed|\b401\b|\b403\b|forbidden/i,
    'la clave del servicio de voz no vale',
  ],
  [/\b429\b|rate limit|quota/i, 'el servicio de voz está saturado'],
  [
    /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i,
    'no hay conexión con el servicio de voz',
  ],
  [/\b5\d\d\b|overloaded|unavailable|bad gateway/i, 'el servicio de voz no responde bien'],
  [/ETIMEDOUT|timed? ?out/i, 'tardó demasiado'],
  [/EACCES|EPERM|denied/i, 'no tengo permiso para usar el micro o el archivo'],
  [/ENOENT|not found|spawn/i, 'falta un programa o archivo de voz'],
];

const MAX = 160;

/** Frase en castellano para el dueño a partir del fallo crudo de voz. */
export function plainVoiceError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  if (!raw) return 'fallo interno (el detalle está en el registro)';
  if (!TECHNICAL.some((p) => p.test(raw)))
    return raw.length > MAX ? `${raw.slice(0, MAX - 1)}…` : raw;
  for (const [p, text] of RULES) if (p.test(raw)) return text;
  return 'fallo interno (el detalle está en el registro)';
}

/**
 * Vetting and builders for adopting a third-party service ("modo Gertru").
 *
 * The rules of the house, made code:
 * - Coste 0: anything that smells of a paid plan, a required subscription or a
 *   card stops the proposal; Nico hears why and decides.
 * - Private by default: the only exposure this capability can build is the
 *   tailnet (`tailscale serve`); there is NO public/funnel path in code - a
 *   public URL needs Nico's explicit say-so and a deliberate change, not a
 *   parameter.
 * - Honest reporting: every adoption ends saying what was verified and what
 *   was not; the builders here carry the fixed caveats (host PC must stay
 *   on, phone link untested until Nico opens it).
 */
import type { ServiceExpose, ServiceMethod } from './store.js';

/** Licenses we accept without asking twice (SPDX ids, compared case-insensitively). */
export const LICENSE_ALLOWLIST = new Set([
  'mit',
  'apache-2.0',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'mpl-2.0',
  'unlicense',
  '0bsd',
  'cc0-1.0',
]);

export type VetVerdict = 'ok' | 'unknown' | 'refused';

/** License vet: allowlisted -> ok; empty/unreadable -> unknown; anything else -> refused. */
export function vetLicense(license: string): VetVerdict {
  const l = license.trim().toLowerCase();
  if (!l || l === 'unknown' || l === 'noassertion' || l === 'desconocida') return 'unknown';
  return LICENSE_ALLOWLIST.has(l) ? 'ok' : 'refused';
}

/**
 * Words that smell of money in a service's own description or pricing page.
 * A match does not prove cost; it proves the proposal must stop and ask.
 */
export const COST_WORD =
  /\b(precio|pricing|suscripci[oó]n|subscription|paid|payment|billing|facturaci[oó]n|tarjeta|credit card|premium|pro plan|plan de pago|trial|freemium|comprar|buy now|purchase)\b/i;

export function costSmell(text: string): boolean {
  return COST_WORD.test(text);
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/**
 * The docker-compose.yml for one adopted service. The bind is ALWAYS
 * 127.0.0.1: exposure to the tailnet goes through `tailscale serve`, never
 * through 0.0.0.0, so a mistake here cannot publish anything by itself.
 */
export function buildCompose(opts: {
  name: string;
  image: string;
  port: number;
  dataDir?: string;
  env?: Record<string, string>;
}): string {
  const lines = [
    '# Generado por Asistenta (servicio adoptado). Revisar antes de `docker compose up -d`.',
    'services:',
    `  ${opts.name}:`,
    `    image: ${opts.image}`,
    `    container_name: asistenta-svc-${opts.name}`,
    '    restart: unless-stopped',
    `    ports:`,
    `      - "127.0.0.1:${opts.port}:${opts.port}"`,
  ];
  if (opts.dataDir) {
    lines.push('    volumes:', `      - ./data:${opts.dataDir}`);
  }
  const env = Object.entries(opts.env ?? {});
  if (env.length > 0) {
    lines.push('    environment:');
    for (const [k, v] of env) lines.push(`      ${k}: ${JSON.stringify(v)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * tailscale serve argv: expose an already-local port on the tailnet ONLY.
 * `serve` (no `funnel`) never leaves the tailnet; there is deliberately no
 * builder for `tailscale funnel` anywhere in this module.
 * Flag syntax follows tailscale >= 1.56; the caller verifies with
 * `tailscale serve status` and reports what it actually shows.
 */
export function tailscaleServeArgs(port: number): string[] {
  return ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`];
}

export function tailscaleServeOffArgs(): string[] {
  return ['serve', '--https=443', 'off'];
}

export function tailscaleStatusArgs(): string[] {
  return ['serve', 'status'];
}

/** Fixed honest caveats for every served service, in Nico's Spanish. */
export const SERVE_CAVEATS = [
  'El PC anfitrión tiene que estar encendido y con Tailscale activo para que el enlace abra.',
  'Tu conexión real desde el móvil sigue sin probar: ábrelo tú con Tailscale encendido.',
] as const;

/** What the adoption flow verifies by itself vs. what it can never verify. */
export function defaultUnverified(method: ServiceMethod, expose: ServiceExpose): string[] {
  const out: string[] = [];
  if (expose === 'tailnet') out.push(...SERVE_CAVEATS);
  if (method === 'local') {
    out.push('La instalación local corre en tu PC; su actualización y limpieza son manuales.');
  }
  return out;
}

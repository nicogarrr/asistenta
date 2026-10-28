/**
 * Adopted services ("modo Gertru"): durable registry of third-party tools
 * Asistenta adopted at Nico's request - one Markdown file per service under
 * <state>/services/, the same pattern as the gestor playbooks and the skills
 * store: Nico can read and fix a file by hand, and every write round-trips
 * through the format instead of a private in-memory shape.
 *
 * What a service file is: source, version, license, cost note, install
 * method, bind (localhost/tailnet), and the honest verification record -
 * what was ACTUALLY checked (the port answered, the container is healthy)
 * versus what was NOT (Nico's phone over Tailscale). Knowledge only plus
 * that record; credentials NEVER live here - a save or read whose rendered
 * content matches a current vault value is rejected/blocked, exactly like
 * the playbooks guard.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { containsVaultValue } from '../gestor/playbooks.js';

export type ServiceMethod = 'docker' | 'local';
export type ServiceExpose = 'ninguna' | 'localhost' | 'tailnet';
export type ServiceStatus = 'propuesto' | 'instalado' | 'servido' | 'parado';

export interface AdoptedService {
  /** Canonical name: [a-z0-9-], doubles as the file name. */
  name: string;
  /** Where it came from (repo or project URL), as declared after research. */
  source: string;
  version: string;
  license: string;
  /** Cost note; the capability refuses anything that is not free. */
  cost: string;
  method: ServiceMethod;
  /** Compose file path or install command summary - how to reproduce it. */
  installRef: string;
  port?: number;
  expose: ServiceExpose;
  /** tailscale serve URL once served; never a public/funnel URL. */
  tailscaleUrl?: string;
  status: ServiceStatus;
  /** Checks that ACTUALLY ran and passed, one line each. */
  verified: string[];
  /** What is NOT verified, said plainly (e.g. "tu conexión desde el móvil"). */
  unverified: string[];
  createdAt: string;
  updatedAt: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_LINE = 300;
const MAX_LINES = 40;

/** The canonical service name for an input, or null when unsafe/invalid. */
export function canonicalServiceName(input: string): string | null {
  const name = input.trim().toLowerCase();
  if (!NAME_RE.test(name)) return null;
  if (name.includes('..')) return null;
  return name;
}

export function renderService(s: AdoptedService): string {
  const section = (title: string, lines: string[]): string[] => [
    `## ${title}`,
    '',
    ...(lines.length > 0 ? lines.map((l) => `- ${l}`) : ['(sin notas)']),
    '',
  ];
  return [
    '---',
    `name: ${s.name}`,
    `source: ${s.source}`,
    `version: ${s.version}`,
    `license: ${s.license}`,
    `cost: ${s.cost}`,
    `method: ${s.method}`,
    `install_ref: ${s.installRef}`,
    ...(s.port !== undefined ? [`port: ${s.port}`] : []),
    `expose: ${s.expose}`,
    ...(s.tailscaleUrl ? [`tailscale_url: ${s.tailscaleUrl}`] : []),
    `status: ${s.status}`,
    `created: ${s.createdAt}`,
    `updated: ${s.updatedAt}`,
    '---',
    '',
    `# Servicio: ${s.name}`,
    '',
    ...section('Verificado', s.verified),
    ...section('Sin verificar', s.unverified),
  ]
    .join('\n')
    .trimEnd()
    .concat('\n');
}

/** Reads one service file back out; tolerant of hand edits, strict on shape. */
export function parseService(text: string): AdoptedService | null {
  const get = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(text);
    return (m?.[1] ?? '').trim();
  };
  const section = (title: string): string[] => {
    const re = new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?=\\n## |$)`);
    const body = re.exec(text)?.[1] ?? '';
    return body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim())
      .filter((l) => l && l !== '(sin notas)')
      .slice(0, MAX_LINES);
  };
  const name = canonicalServiceName(get('name') ?? '');
  if (!name) return null;
  const method = get('method');
  const expose = get('expose');
  const status = get('status');
  if (method !== 'docker' && method !== 'local') return null;
  if (expose !== 'ninguna' && expose !== 'localhost' && expose !== 'tailnet') return null;
  if (!['propuesto', 'instalado', 'servido', 'parado'].includes(status)) return null;
  const portRaw = get('port');
  const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
  return {
    name,
    source: get('source'),
    version: get('version'),
    license: get('license'),
    cost: get('cost'),
    method,
    installRef: get('install_ref'),
    port:
      port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined,
    expose: expose as ServiceExpose,
    tailscaleUrl: get('tailscale_url') || undefined,
    status: status as ServiceStatus,
    verified: section('Verificado'),
    unverified: section('Sin verificar'),
    createdAt: get('created'),
    updatedAt: get('updated'),
  };
}

/** A line is one line; a section stays glanced-at-able, not a novel. */
export function validateService(s: AdoptedService): string | null {
  if (!canonicalServiceName(s.name)) return `nombre de servicio no válido: "${s.name}"`;
  if (!s.source.trim()) return 'falta la fuente (URL del repo o proyecto)';
  if (!s.installRef.trim()) return 'falta install_ref (cómo se instala)';
  for (const l of [...s.verified, ...s.unverified]) {
    if (l.includes('\n')) return 'cada nota es una línea';
    if (l.length > MAX_LINE) return `nota demasiado larga (>${MAX_LINE} caracteres)`;
  }
  if (s.verified.length > MAX_LINES || s.unverified.length > MAX_LINES) {
    return `demasiadas notas (>${MAX_LINES} por sección)`;
  }
  return null;
}

export class ServiceStore {
  readonly #dir: string;

  constructor(opts: { dir: string }) {
    this.#dir = opts.dir;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  #file(name: string): string {
    return join(this.#dir, `${name}.md`);
  }

  read(name: string): AdoptedService | null {
    const canonical = canonicalServiceName(name);
    if (!canonical) return null;
    const file = this.#file(canonical);
    if (!existsSync(file)) return null;
    try {
      return parseService(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  list(): AdoptedService[] {
    if (!existsSync(this.#dir)) return [];
    const out: AdoptedService[] = [];
    for (const f of readdirSync(this.#dir)) {
      if (!f.endsWith('.md')) continue;
      const s = this.read(f.slice(0, -3));
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Writes go through the vault guard: the rendered file is checked against
   * ALL current vault values (exact, case-sensitive substring, one snapshot
   * per call). One match and nothing is written. Returns the guard verdict so
   * the caller answers with the generic refusal - the matched value is never
   * named or echoed.
   */
  save(s: AdoptedService, vaultValues: readonly string[]): 'ok' | 'secret' | 'invalid' {
    if (validateService(s) !== null) return 'invalid';
    const rendered = renderService(s);
    if (containsVaultValue(rendered, vaultValues)) return 'secret';
    const tmp = `${this.#file(s.name)}.${randomUUID()}.tmp`;
    writeFileSync(tmp, rendered, { mode: 0o600 });
    renameSync(tmp, this.#file(s.name));
    return 'ok';
  }

  remove(name: string): boolean {
    const canonical = canonicalServiceName(name);
    if (!canonical) return false;
    const file = this.#file(canonical);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }
}

/** What /servicios prints: one line per adopted service, Spanish, honest. */
export function formatServicesList(all: AdoptedService[]): string {
  if (all.length === 0) {
    return 'No hay servicios adoptados. Pídeme "adopta <herramienta>" y te propongo el plan antes de instalar nada.';
  }
  const lines = all.map((s) => {
    const net = s.expose === 'tailnet' && s.tailscaleUrl ? ` · ${s.tailscaleUrl}` : '';
    return `- ${s.name} [${s.status}] ${s.source} (${s.license}, ${s.cost})${net}`;
  });
  return [
    'Servicios adoptados:',
    ...lines,
    '',
    'Detalle y verificación de cada uno: "estado de <nombre>" o mira su ficha.',
  ].join('\n');
}

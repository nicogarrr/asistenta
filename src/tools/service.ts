/**
 * `servicio` - adopt a third-party tool at Nico's request and serve it back
 * to him privately ("modo Gertru"): vet it (license, €0), install it
 * sandboxed, expose it ONLY on the tailnet with `tailscale serve`, and report
 * with honesty what was verified and what was not.
 *
 * The rules of the house, wired in rather than remembered:
 * - `instalar` is hardcoded always-ask in the Gate (see permissions.ts,
 *   `ask-servicio-instalar`): Nico approves every adoption, plan in hand.
 * - There is NO public exposure action: the only builder in services/adopt.ts
 *   produces tailnet-only `tailscale serve` argv. A public/funnel URL is not
 *   a parameter away; it needs Nico's explicit say-so and a code change.
 * - Coste 0: a proposal whose own text smells of price/subscription/card is
 *   refused before anything is saved; Nico hears why.
 * - Credentials never land in the registry: every save and read goes through
 *   the same vault-value guard as the gestor playbooks.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { childEnv } from '../child-env.js';
import { containsVaultValue } from '../gestor/playbooks.js';
import { log } from '../log.js';
import {
  buildCompose,
  costSmell,
  defaultUnverified,
  isValidPort,
  tailscaleServeArgs,
  tailscaleServeOffArgs,
  tailscaleStatusArgs,
  vetLicense,
} from '../services/adopt.js';
import {
  type AdoptedService,
  canonicalServiceName,
  renderService,
  type ServiceStore,
  validateService,
} from '../services/store.js';
import { vaultSnapshotValues } from '../vault.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

/** Real process execution: argv array, never a shell string. */
export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024, env: childEnv() },
      (err, stdout, stderr) => {
        const code =
          typeof (err as { code?: number } | null)?.code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        // A missing binary (ENOENT) or a 2-minute timeout leave stderr empty;
        // keep err's own words so the plain line below can tell them apart.
        const e = err as (Error & { killed?: boolean }) | null;
        const why = e ? (e.killed ? 'ETIMEDOUT' : e.message) : '';
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || why });
      },
    );
  });

export interface ServiceToolDeps {
  services: ServiceStore;
  /** Dir for generated compose files, inside the state dir. */
  servicesDir: string;
  run?: Runner;
  vaultSnapshotValues?: () => Promise<string[]>;
  /** HTTP probe of 127.0.0.1:port after install; injected in tests. */
  probePort?: (port: number) => Promise<boolean>;
  now?: () => string;
}

const defaultProbe = async (port: number): Promise<boolean> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
};

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('proponer'),
    Type.Literal('instalar'),
    Type.Literal('servir'),
    Type.Literal('parar'),
    Type.Literal('listar'),
    Type.Literal('estado'),
  ]),
  nombre: Type.Optional(Type.String({ description: 'Nombre corto del servicio [a-z0-9-].' })),
  fuente: Type.Optional(
    Type.String({ description: 'proponer: URL del repo/proyecto, tras investigarlo.' }),
  ),
  version: Type.Optional(Type.String({ description: 'proponer: versión concreta adoptada.' })),
  licencia: Type.Optional(
    Type.String({
      description: 'proponer: licencia SPDX leída en la fuente (MIT, Apache-2.0...).',
    }),
  ),
  coste: Type.Optional(
    Type.String({
      description: 'proponer: nota de coste leída en la fuente ("gratis", "open source").',
    }),
  ),
  metodo: Type.Optional(
    Type.Union([Type.Literal('docker'), Type.Literal('local')], {
      description: 'proponer: docker (compose generado) o local (comando declarado).',
    }),
  ),
  imagen: Type.Optional(Type.String({ description: 'proponer (docker): imagen a usar.' })),
  comando: Type.Optional(
    Type.String({
      description: 'proponer (local): comando de instalación/arranque, argv separado por espacios.',
    }),
  ),
  puerto: Type.Optional(
    Type.Number({ description: 'proponer: puerto local en el que sirve (1024-65535).' }),
  ),
  notas: Type.Optional(
    Type.String({ description: 'proponer: resumen honesto de lo investigado.' }),
  ),
});

/**
 * Docker's own words (daemon pipe, Windows path, exit code) go to the log; the
 * chat gets one plain line saying what happened and what Nico can do.
 */
export function dockerFailText(res: RunResult): string {
  const raw = `${res.stderr}\n${res.stdout}`;
  if (/ENOENT|is not recognized|no se reconoce|command not found/i.test(raw))
    return 'no encuentro Docker en este PC. Instala Docker Desktop (es gratis) o ábrelo, y vuelve a pedírmelo';
  if (/ETIMEDOUT|timed? ?out/i.test(raw))
    return 'Docker tardó más de 2 minutos y lo he cortado. Vuelve a pedírmelo en un momento';
  if (
    /cannot connect to the docker daemon|daemon (is )?not running|error during connect|docker_engine|dockerDesktop\w*Engine/i.test(
      raw,
    )
  )
    return 'Docker no está arrancado. Abre Docker Desktop, espera a que diga que está listo y vuelve a pedírmelo';
  if (/port is already allocated|address already in use|only one usage of each socket/i.test(raw))
    return 'el puerto ya lo está usando otro programa. Ciérralo o elige otro puerto';
  if (/pull access denied|manifest unknown|repository does not exist|no such image/i.test(raw))
    return 'Docker no encuentra esa imagen. Revisa el nombre de la imagen';
  if (/permission denied|access is denied|acceso denegado/i.test(raw))
    return 'Docker no me deja (permiso denegado). Abre Docker Desktop con tu usuario y vuelve a pedírmelo';
  return 'Docker dio un error que no reconozco (el detalle técnico queda en el registro del PC)';
}

/**
 * `tailscale serve` failures: Tailscale's own words (socket paths, node ids,
 * operator hints for Linux) go to the log; the chat gets what happened and
 * what Nico can do. The admin-console link Tailscale prints to enable Serve is
 * kept: it is the one thing he needs to click.
 */
export function tailscaleServeFailText(res: RunResult): string {
  const raw = `${res.stderr}\n${res.stdout}`;
  if (/serve is not enabled|funnel is not enabled|not enabled on your tailnet/i.test(raw)) {
    const link = /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/i.exec(raw)?.[0];
    return link
      ? `tu tailnet no tiene activado Serve. Actívalo una vez aquí: ${link} y vuelve a pedírmelo`
      : 'tu tailnet no tiene activado Serve. Actívalo en la consola de Tailscale (DNS → HTTPS y Serve) y vuelve a pedírmelo';
  }
  if (/needs ?login|logged out|not logged in|log in|login required/i.test(raw))
    return 'Tailscale no tiene la sesión iniciada en este PC. Abre Tailscale, inicia sesión y vuelve a pedírmelo';
  if (
    /failed to connect to local tailscaled|tailscaled.*not running|is tailscaled running|service is not running|connection refused/i.test(
      raw,
    )
  )
    return 'Tailscale no está arrancado. Ábrelo, espera a que diga «Connected» y vuelve a pedírmelo';
  if (/ETIMEDOUT|timed? ?out/i.test(raw))
    return 'Tailscale tardó demasiado en contestar y lo he cortado. Vuelve a pedírmelo en un momento';
  if (/access denied|permission denied|acceso denegado|--operator|operator/i.test(raw))
    return 'Tailscale no me deja cambiar Serve con este usuario (permiso denegado). En Linux: `sudo tailscale set --operator=$USER`; en Windows, abre Tailscale con tu usuario';
  if (/https certificates? (are|is) not enabled|enable https|certificate/i.test(raw))
    return 'tu tailnet no tiene activados los certificados HTTPS. Actívalos en la consola de Tailscale (DNS → HTTPS) y vuelve a pedírmelo';
  return 'Tailscale dio un error que no reconozco (el detalle técnico queda en el registro del PC)';
}

function dockerFail(step: string, service: string, res: RunResult): string {
  log.warn('docker compose failed', {
    step,
    service,
    code: res.code,
    detail: (res.stderr || res.stdout).slice(0, 500),
  });
  return dockerFailText(res);
}

function reply(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/** The honest closing block of every adoption report: verified vs. not. */
export function formatVerification(s: AdoptedService): string {
  const yes = s.verified.length > 0 ? s.verified.map((v) => `- ${v}`).join('\n') : '- (nada aún)';
  const no =
    s.unverified.length > 0 ? s.unverified.map((v) => `- ${v}`).join('\n') : '- (nada pendiente)';
  return ['Verificado de verdad:', yes, '', 'NO verificado:', no].join('\n');
}

/** Persist with the vault guard; a 'secret' verdict answers with the generic refusal. */
async function persist(deps: ServiceToolDeps, s: AdoptedService): Promise<AgentToolResult | null> {
  const invalid = validateService(s);
  if (invalid) return reply(`No se guarda: ${invalid}.`, true);
  const saved = deps.services.save(s, await (deps.vaultSnapshotValues ?? vaultSnapshotValues)());
  if (saved === 'secret') {
    return reply(
      'No se guarda: el contenido coincide con un valor del vault. Credenciales solo por NOMBRE de clave, nunca el valor.',
      true,
    );
  }
  if (saved === 'invalid') return reply('No se guarda: registro no válido.', true);
  return null;
}

export function createServiceTool(deps: ServiceToolDeps): AgentTool<typeof Params> {
  const run = deps.run ?? defaultRunner;
  const probe = deps.probePort ?? defaultProbe;
  const now = deps.now ?? (() => new Date().toISOString());

  const load = (nombre: string | undefined): AdoptedService | AgentToolResult => {
    const name = canonicalServiceName(nombre ?? '');
    if (!name) return reply('Indica un nombre de servicio válido [a-z0-9-].', true);
    const s = deps.services.read(name);
    if (!s) return reply(`No hay ningún servicio "${name}" adoptado o propuesto.`, true);
    return s;
  };

  return {
    name: 'servicio',
    label: 'Servicio adoptado',
    description: [
      'Adoptar una herramienta externa a petición del usuario ("adopta X", "instala Y y pásame el enlace").',
      'proponer: investiga primero la fuente con fetch/web (licencia real, coste real, mantenimiento) y declara lo leído; muestra el plan. Nada se instala aquí.',
      'instalar: ejecuta la instalación declarada - SOLO tras el sí explícito del usuario al plan; la Gate vuelve a preguntar siempre.',
      'servir: expone el servicio SOLO en la tailnet con `tailscale serve`. No existe exposición pública/funnel: si piden público, di que necesitas el OK explícito de Nico y aun así hoy no hay acción para ello.',
      'parar: detiene un servicio docker. listar/estado: qué hay adoptado y con qué verificación.',
      'Cierra SIEMPRE con honestidad: qué se verificó de verdad (puerto, contenedor, serve status) y qué NO (p. ej. la conexión desde el móvil de Nico).',
      'Credenciales nunca en parámetros ni en notas: van al vault, aquí solo NOMBRES de clave.',
    ].join('\n'),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      if (args.action === 'proponer') {
        const name = canonicalServiceName(args.nombre ?? '');
        if (!name) return reply('proponer necesita un nombre corto válido [a-z0-9-].', true);
        if (!args.fuente?.trim())
          return reply('proponer necesita la fuente (URL) investigada.', true);
        if (!args.licencia?.trim())
          return reply('proponer necesita la licencia leída en la fuente.', true);
        if (!args.metodo) return reply('proponer necesita el método (docker o local).', true);
        if (args.metodo === 'docker' && !args.imagen?.trim()) {
          return reply('método docker: falta la imagen.', true);
        }
        if (args.metodo === 'local' && !args.comando?.trim()) {
          return reply('método local: falta el comando de instalación/arranque.', true);
        }
        if (args.puerto !== undefined && !isValidPort(args.puerto)) {
          return reply('puerto no válido: usa uno entre 1024 y 65535.', true);
        }
        const vet = vetLicense(args.licencia);
        if (vet === 'refused') {
          return reply(
            `No lo adopto: la licencia "${args.licencia}" no está en la lista aceptada (MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unlicense, CC0). Si Nico la acepta a sabiendas, que lo diga y revisamos el caso.`,
            true,
          );
        }
        const declared = `${args.notas ?? ''}\n${args.coste ?? ''}\n${args.fuente}`;
        if (costSmell(declared)) {
          return reply(
            'Alto: en lo investigado aparecen señales de coste (precio/suscripción/pago). Regla de la casa: stack €0. No registro la propuesta; si Nico confirma que es gratis de verdad, reformulo sin esas señales.',
            true,
          );
        }
        const existing = deps.services.read(name);
        const s: AdoptedService = {
          name,
          source: args.fuente.trim(),
          version: (args.version ?? '').trim() || 'sin fijar',
          license: args.licencia.trim(),
          cost: (args.coste ?? '').trim() || 'gratis (declarado)',
          method: args.metodo,
          // installRef = how to reproduce it: the image (docker) or the command (local).
          installRef: (args.metodo === 'docker' ? args.imagen : args.comando)?.trim() ?? '',
          port: args.puerto,
          expose: 'ninguna',
          status: 'propuesto',
          verified: [],
          unverified: [
            ...(vet === 'unknown'
              ? [
                  `Licencia no verificada del todo: la fuente dice "${args.licencia}"; confírmala antes de instalar.`,
                ]
              : []),
            'Licencia, coste y mantenimiento son lo leído en la fuente declarada; no una auditoría del código.',
          ],
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
        };
        const blocked = await persist(deps, s);
        if (blocked) return blocked;
        return reply(
          [
            `📦 Servicio propuesto: "${name}"`,
            '',
            `Fuente: ${s.source}`,
            `Versión: ${s.version} · Licencia: ${s.license} · Coste: ${s.cost}`,
            `Método: ${s.method} (${s.installRef})`,
            s.port !== undefined
              ? `Puerto local: ${s.port} (bind 127.0.0.1; nunca 0.0.0.0)`
              : 'Sin puerto: no sirve nada por red.',
            '',
            'Para instalarlo hace falta tu sí explícito: la instalación siempre pregunta.',
            '',
            formatVerification(s),
          ].join('\n'),
        );
      }

      if (args.action === 'instalar') {
        const s = load(args.nombre);
        if ('content' in s) return s;
        if (s.status !== 'propuesto' && s.status !== 'parado') {
          return reply(`"${s.name}" está en estado ${s.status}; nada que instalar.`, true);
        }
        const verified: string[] = [];
        const unverified = [...s.unverified];
        if (s.method === 'docker') {
          const dir = join(deps.servicesDir, s.name);
          mkdirSync(dir, { recursive: true });
          if (s.port === undefined) {
            return reply(
              `"${s.name}" no tiene puerto declarado; el compose generado lo necesita.`,
              true,
            );
          }
          const file = join(dir, 'docker-compose.yml');
          writeFileSync(file, buildCompose({ name: s.name, image: s.installRef, port: s.port }), {
            mode: 0o600,
          });
          const up = await run('docker', ['compose', '-f', file, 'up', '-d']);
          if (up.code !== 0) {
            return reply(`No pude arrancarlo: ${dockerFail('up', s.name, up)}.`, true);
          }
          verified.push('`docker compose up -d` terminó sin error.');
          const ps = await run('docker', ['compose', '-f', file, 'ps', '--status', 'running']);
          if (ps.code === 0 && ps.stdout.includes(s.name)) {
            verified.push(`El contenedor asistenta-svc-${s.name} aparece en marcha.`);
          } else {
            unverified.push('No pude confirmar el contenedor en marcha con `docker compose ps`.');
          }
        } else {
          const argv = splitCommandLine(s.installRef);
          if (argv === null) {
            return reply(
              `"${s.name}": el comando declarado tiene comillas sin cerrar; corrígelo antes de instalar.`,
              true,
            );
          }
          if (argv.length === 0) {
            return reply(`"${s.name}" no tiene comando declarado.`, true);
          }
          const [cmd, ...rest] = argv as [string, ...string[]];
          const res = await run(cmd, rest);
          if (res.code !== 0) {
            return reply(
              `El comando de instalación falló (${cmd}): ${(res.stderr || res.stdout).slice(0, 500)}`,
              true,
            );
          }
          verified.push(`El comando declarado (\`${s.installRef}\`) terminó sin error.`);
        }
        if (s.port !== undefined) {
          if (await probe(s.port)) {
            verified.push(`http://127.0.0.1:${s.port} responde desde este PC.`);
          } else {
            unverified.push(
              `http://127.0.0.1:${s.port} NO respondió al probarlo; el servicio puede tardar en arrancar o no tener interfaz web.`,
            );
          }
        }
        const next: AdoptedService = {
          ...s,
          status: 'instalado',
          verified: [...s.verified, ...verified],
          unverified,
          updatedAt: now(),
        };
        const blocked = await persist(deps, next);
        if (blocked) return blocked;
        return reply(
          [`✅ Servicio "${s.name}" instalado.`, '', formatVerification(next)].join('\n'),
        );
      }

      if (args.action === 'servir') {
        const s = load(args.nombre);
        if ('content' in s) return s;
        if (s.status !== 'instalado' && s.status !== 'servido' && s.status !== 'parado') {
          return reply(
            `"${s.name}" está en estado ${s.status}; instálalo antes de servirlo.`,
            true,
          );
        }
        if (s.port === undefined) {
          return reply(`"${s.name}" no tiene puerto declarado; no hay nada que servir.`, true);
        }
        // `tailscale serve --https=443` apunta la raíz del nodo a UN puerto: servir otro
        // servicio reemplazaría al que ya está (cuya ficha seguiría diciendo «servido»
        // con un enlace que abre otra cosa), y pararlo luego apagaría a los dos.
        const occupant = deps.services
          .list()
          .find((o) => o.name !== s.name && o.expose === 'tailnet');
        if (occupant) {
          return reply(
            `Tu tailnet ya sirve "${occupant.name}" y solo cabe un servicio a la vez: servir "${s.name}" lo reemplazaría. Para "${occupant.name}" primero (acción parar) y lo sirvo. No he expuesto nada.`,
            true,
          );
        }
        const cli = await run('tailscale', ['version']);
        if (cli.code !== 0) {
          return reply(
            'No encuentro el CLI de Tailscale en este PC (o no responde). No sirvo nada; instálalo/arráncalo y lo retomo.',
            true,
          );
        }
        const up = await run('tailscale', tailscaleServeArgs(s.port));
        if (up.code !== 0) {
          log.warn('tailscale serve failed', {
            service: s.name,
            code: up.code,
            detail: (up.stderr || up.stdout).slice(0, 500),
          });
          return reply(
            `No pude servirlo en tu tailnet: ${tailscaleServeFailText(up)}. No he expuesto nada.`,
            true,
          );
        }
        const status = await run('tailscale', tailscaleStatusArgs());
        const statusText = (status.stdout || status.stderr).trim();
        const urlMatch = /https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?/i.exec(statusText);
        const verified = ['`tailscale serve` aceptó el reenvío (solo tailnet; sin funnel).'];
        const unverified = [...s.unverified];
        if (urlMatch) {
          verified.push(`\`tailscale serve status\` muestra ${urlMatch[0]}.`);
        } else {
          unverified.push('`tailscale serve status` no mostró la URL esperada; revísalo a mano.');
        }
        for (const c of defaultUnverified(s.method, 'tailnet')) {
          if (!unverified.includes(c)) unverified.push(c);
        }
        const next: AdoptedService = {
          ...s,
          status: 'servido',
          expose: 'tailnet',
          tailscaleUrl: urlMatch?.[0] ?? s.tailscaleUrl,
          verified: [...s.verified, ...verified],
          unverified,
          updatedAt: now(),
        };
        const blocked = await persist(deps, next);
        if (blocked) return blocked;
        return reply(
          [
            `🔗 Servicio "${s.name}" servido en tu tailnet${next.tailscaleUrl ? `: ${next.tailscaleUrl}` : '.'}`,
            '',
            'Activa Tailscale en el móvil antes de abrirlo.',
            '',
            formatVerification(next),
          ].join('\n'),
        );
      }

      if (args.action === 'parar') {
        const s = load(args.nombre);
        if ('content' in s) return s;
        if (s.method !== 'docker') {
          return reply(
            `"${s.name}" es local: no sé pararlo yo solo. Comando declarado: ${s.installRef}. Para el proceso a mano y avísame.`,
            true,
          );
        }
        if (s.expose === 'tailnet') {
          // Best effort: retire the tailnet forwarding before stopping, so no
          // dangling serve entry points at a dead port.
          await run('tailscale', tailscaleServeOffArgs());
        }
        const file = join(deps.servicesDir, s.name, 'docker-compose.yml');
        const stop = await run('docker', ['compose', '-f', file, 'stop']);
        if (stop.code !== 0) {
          return reply(`No pude pararlo: ${dockerFail('stop', s.name, stop)}.`, true);
        }
        const next: AdoptedService = {
          ...s,
          status: 'parado',
          expose: 'ninguna',
          tailscaleUrl: undefined,
          verified: [...s.verified, '`docker compose stop` terminó sin error.'],
          updatedAt: now(),
        };
        const blocked = await persist(deps, next);
        if (blocked) return blocked;
        return reply(`⏹ Servicio "${s.name}" parado. El enlace tailnet deja de responder.`);
      }

      if (args.action === 'listar') {
        const all = deps.services.list();
        if (all.length === 0) {
          return reply('No hay servicios adoptados. Con "adopta <herramienta>" te propongo uno.');
        }
        const lines = all.map(
          (s) =>
            `- ${s.name} [${s.status}${s.expose === 'tailnet' ? ', tailnet' : ''}] ${s.source} · ${s.license} · ${s.cost}`,
        );
        return reply(['Servicios adoptados:', ...lines].join('\n'));
      }

      if (args.action === 'estado') {
        const s = load(args.nombre);
        if ('content' in s) return s;
        // Read revalidates like save: a hand-edited file quoting a current
        // vault value is blocked, never returned (same rule as playbooks).
        const values = await (deps.vaultSnapshotValues ?? vaultSnapshotValues)();
        if (containsVaultValue(renderService(s), values)) {
          return reply(
            `La ficha de "${s.name}" está bloqueada: su contenido coincide con un valor actual del vault. Revísala a mano (services/${s.name}.md).`,
            true,
          );
        }
        return reply(renderService(s));
      }

      return reply(`Acción desconocida.`, true);
    },
  };
}

/**
 * Split a declared command into argv WITHOUT a shell: whitespace separates,
 * "double" and 'single' quotes group (so `--title "Mi tablero"` stays one
 * argument), and a backslash only escapes `"` or `\\` inside double quotes -
 * Windows paths keep their backslashes. Unbalanced quotes -> null (refuse).
 */
export function splitCommandLine(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        cur += line[i + 1];
        i++;
      } else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

/**
 * F12 — Sandbox opcional para la herramienta shell.
 *
 * PA_SHELL_SANDBOX=off (por defecto) ejecuta pwsh en el PC como siempre.
 * PA_SHELL_SANDBOX=docker ejecuta cada comando en un contenedor desechable:
 * sin red, raíz de solo lectura, sin capacidades, usuario sin privilegios,
 * límites de CPU/memoria y SOLO la carpeta de trabajo montada en /work.
 * Si docker falta o el valor no se reconoce, el comando se RECHAZA: nunca se cae
 * al host en silencio.
 *
 * `wsl` no se ofrece a propósito: WSL ve todo C: en /mnt/c y tiene red, así que
 * no aísla nada y daría una falsa sensación de seguridad.
 */

import { execFile } from 'node:child_process';

export type SandboxMode = 'off' | 'docker';

/**
 * Imagen fijada por digest (sha256 del índice multi-arquitectura, leído del
 * registro de MCR el 30-oct-2026): `:latest` cambiaría bajo los pies del dueño
 * y una etiqueta se puede reescribir; el digest no. Para actualizarla, cambia
 * etiqueta y digest juntos.
 */
export const DEFAULT_SANDBOX_IMAGE =
  'mcr.microsoft.com/powershell:7.4-ubuntu-22.04@sha256:62300a213a9293916333df2b014cd3a8f22fb0b0b65f2bb446aaf436bcf8c868';

/** ¿La imagen va fijada por digest (`…@sha256:<64 hex>`)? */
export function isDigestPinned(image: string): boolean {
  return /@sha256:[0-9a-f]{64}$/.test(image.trim());
}

/** Versión del servidor docker, o null si docker falta o no responde. */
export type DockerProbe = () => Promise<string | null>;

export const probeDocker: DockerProbe = () =>
  new Promise((resolve) => {
    execFile(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        const v = String(stdout ?? '').trim();
        resolve(err || !v ? null : v);
      },
    );
  });

/**
 * Líneas de `pa doctor` sobre el sandbox de la shell: el modo, si docker
 * responde y qué imagen se usaría (y si va fijada por digest).
 */
export async function sandboxDoctorLines(
  env: NodeJS.ProcessEnv = process.env,
  probe: DockerProbe = probeDocker,
): Promise<string[]> {
  const mode = sandboxMode(env);
  const docker = await probe().catch(() => null);
  const lines: string[] = [];
  if (!mode.ok) {
    lines.push(`shell sandbox   INVÁLIDO: ${mode.error}`);
  } else if (mode.mode === 'off') {
    lines.push(
      'shell sandbox   off (la shell corre en el PC; PA_SHELL_SANDBOX=docker para aislarla)',
    );
  } else {
    lines.push('shell sandbox   docker (cada comando en un contenedor sin red)');
  }
  const needsDocker = mode.ok && mode.mode === 'docker';
  lines.push(
    `docker          ${
      docker
        ? `ok (servidor ${docker})`
        : needsDocker
          ? 'NO RESPONDE: los comandos de shell se rechazarán hasta que arranque Docker'
          : 'no disponible (solo hace falta con PA_SHELL_SANDBOX=docker)'
    }`,
  );
  if (needsDocker) {
    const custom = env.PA_SHELL_SANDBOX_IMAGE?.trim();
    const image = custom || DEFAULT_SANDBOX_IMAGE;
    lines.push(
      `sandbox image   ${image} (${
        isDigestPinned(image)
          ? 'fijada por digest'
          : 'SIN digest: puede cambiar sola; usa imagen@sha256:…'
      })`,
    );
  }
  return lines;
}

export function sandboxMode(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; mode: SandboxMode } | { ok: false; error: string } {
  const raw = (env.PA_SHELL_SANDBOX ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off' || raw === '0') return { ok: true, mode: 'off' };
  if (raw === 'docker') return { ok: true, mode: 'docker' };
  return {
    ok: false,
    error: `PA_SHELL_SANDBOX=${raw} no es un modo válido (off o docker). No ejecuto el comando para no caer al PC sin aislamiento.`,
  };
}

export interface SandboxSpawn {
  file: string;
  args: string[];
  /** Nombre del contenedor, para matarlo si se agota el tiempo. */
  container?: string;
}

/** Docker en Windows quiere rutas con barras normales para -v. */
function dockerPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function buildSandboxSpawn(opts: {
  mode: SandboxMode;
  shellFile: string;
  command: string;
  workspace: string;
  image?: string;
  name?: string;
}): SandboxSpawn {
  const pwshArgs = ['-NoProfile', '-NonInteractive', '-Command', opts.command];
  if (opts.mode === 'off') return { file: opts.shellFile, args: pwshArgs };
  const container = opts.name ?? `pa-shell-${Date.now().toString(36)}`;
  return {
    file: 'docker',
    container,
    args: [
      'run',
      '--rm',
      '-i',
      '--name',
      container,
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=64m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '1000:1000',
      '--cpus',
      '1',
      '--memory',
      '512m',
      '--pids-limit',
      '256',
      '-e',
      'NO_COLOR=1',
      '-e',
      'HOME=/tmp',
      '-v',
      `${dockerPath(opts.workspace)}:/work`,
      '-w',
      '/work',
      opts.image ?? DEFAULT_SANDBOX_IMAGE,
      'pwsh',
      ...pwshArgs,
    ],
  };
}

/** Mensaje claro cuando el modo docker no puede arrancar el contenedor. */
export function sandboxSpawnError(mode: SandboxMode, message: string): string {
  if (mode === 'docker' && /ENOENT/.test(message)) {
    return 'PA_SHELL_SANDBOX=docker pero no encuentro docker en este PC. No he ejecutado nada (no caigo al PC sin aislamiento). Instala Docker Desktop o pon PA_SHELL_SANDBOX=off.';
  }
  return message;
}

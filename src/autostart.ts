import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './paths.js';
import { formatStartupRecord, readStartupRecord, STARTUP_RECORD_FILE } from './startup-record.js';
import { unlock, vaultGet } from './vault.js';
import { resolveOwnerUserId } from './vigilante.js';

export function autostartRepo(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('..', moduleUrl));
}

export async function autostartCommand(
  args: string[],
  opts: { stateDir?: string } = {},
): Promise<number> {
  if (process.platform !== 'win32') {
    process.stderr.write('Autoarranque completo disponible solo en Windows.\n');
    return 2;
  }
  const action = args[0] ?? 'status';
  if (
    !['install', 'status', 'uninstall'].includes(action) ||
    args.slice(1).some((a) => !['--start', '--what-if', '--no-local-llm'].includes(a))
  ) {
    process.stderr.write(
      'uso: pa autostart install|status|uninstall [--start] [--what-if] [--no-local-llm]\n',
    );
    return 2;
  }
  if (action === 'status') {
    const rec = readStartupRecord(join(opts.stateDir ?? paths.state, STARTUP_RECORD_FILE));
    process.stdout.write(`${formatStartupRecord(rec)}\n`);
  }
  const exe = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const repo = autostartRepo();
  const flags = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(repo, 'deploy', 'windows', 'install-all.ps1'),
    '-Action',
    action,
    '-RepoDir',
    repo,
    '-NodeExe',
    process.execPath,
  ];
  // Switch is a literal PowerShell argument, not shell text. The installer defaults local LLM on.
  if (args.includes('--no-local-llm')) flags.push('-DisableLocalLlm');
  if (args.includes('--start')) flags.push('-Start');
  if (args.includes('--what-if')) flags.push('-WhatIf');
  return new Promise<number>((resolve) => {
    execFile(
      exe,
      flags,
      { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (stdout) process.stdout.write(stdout);
        if (error)
          process.stderr.write(
            'Autoarranque no completado; revisa requisitos y permisos locales.\n',
          );
        resolve(error ? 1 : 0);
      },
    );
  });
}

export const SUPERVISOR_MESSAGES = {
  restart:
    'Asistenta: latido detenido más de 120 s. El supervisor externo solicita cierre limpio y reinicio de la tarea. Máximo 3 intentos en 15 min.',
  forced:
    'Asistenta: el cierre limpio no terminó a tiempo. Se terminó solo el proceso propio del launcher. No se declara cierre limpio; revisa pa autostart status y los logs locales.',
  blocked:
    'Asistenta: agotados 3 reinicios del supervisor en 15 min. No forzaré otro. Revisa pa autostart status.',
  supervisor:
    'Asistenta: el supervisor externo no pudo completar una comprobación o guardar su presupuesto. No forzaré un reinicio ni declararé cierre limpio. Revisa pa autostart status y los logs locales.',
  heartbeat:
    'Asistenta: no puedo verificar un latido válido de esta instancia. No termino ningún proceso; revisa pa autostart status.',
} as const;

/** No chat history or group fallback: only the configured owner who is also allowlisted. */
export async function notifyAutostart(
  event: string,
  deps = { unlock, get: vaultGet, fetch: globalThis.fetch },
): Promise<number> {
  if (!(event in SUPERVISOR_MESSAGES) || !Object.hasOwn(SUPERVISOR_MESSAGES, event)) return 2;
  try {
    await deps.unlock();
    const allowed =
      (await deps.get('telegram:allowedUserIds'))
        ?.split(',')
        .map(Number)
        .filter((n) => Number.isSafeInteger(n) && n > 0) ?? [];
    const explicit = Number(await deps.get('vigilante:ownerUserId'));
    const owner = resolveOwnerUserId(
      allowed,
      Number.isSafeInteger(explicit) && explicit > 0 ? explicit : null,
    );
    const token = await deps.get('telegram:botToken');
    if (!owner || !allowed.includes(owner) || !token) return 1;
    const response = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: owner,
        text: SUPERVISOR_MESSAGES[event as keyof typeof SUPERVISOR_MESSAGES],
      }),
    });
    const data: unknown = await response.json();
    return response.ok &&
      data !== null &&
      typeof data === 'object' &&
      'ok' in data &&
      data.ok === true
      ? 0
      : 1;
  } catch {
    return 1;
  }
}

export async function localLlmHealthy(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher('http://127.0.0.1:4096/global/health', {
      signal: AbortSignal.timeout(2000),
    });
    const data: unknown = await response.json();
    return (
      response.ok &&
      data !== null &&
      typeof data === 'object' &&
      'healthy' in data &&
      data.healthy === true &&
      'version' in data &&
      typeof data.version === 'string'
    );
  } catch {
    return false;
  }
}

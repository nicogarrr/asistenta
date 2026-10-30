/**
 * `pa iniciar`: comprueba todo (preflight) y, si nada impide arrancar, levanta el
 * daemon igual que `pa serve`. Con `--solo-comprobar` solo pinta la lista.
 *
 * Códigos de salida: 0 = todo bien (o arrancó y terminó bien), 1 = algo impide
 * arrancar, 2 = uso incorrecto.
 */
import {
  formatPreflight,
  type PreflightDeps,
  preflightExitCode,
  runPreflight,
} from './preflight.js';

export interface IniciarOptions {
  checkOnly: boolean;
  json: boolean;
  offline: boolean;
}

export const INICIAR_USAGE =
  'Uso: pa iniciar [--solo-comprobar] [--sin-red] [--json]\n' +
  '  --solo-comprobar  solo la lista de comprobaciones, sin arrancar\n' +
  '  --sin-red         no valida el token con Telegram ni mira la tele\n' +
  '  --json            la lista en JSON (implica --solo-comprobar)\n';

export function parseIniciarArgs(argv: readonly string[]): IniciarOptions | null {
  const opts: IniciarOptions = { checkOnly: false, json: false, offline: false };
  for (const arg of argv) {
    if (arg === '--solo-comprobar' || arg === '--check') opts.checkOnly = true;
    else if (arg === '--json') {
      opts.json = true;
      opts.checkOnly = true;
    } else if (arg === '--sin-red' || arg === '--offline') opts.offline = true;
    else return null;
  }
  return opts;
}

export interface IniciarIo {
  deps: () => Promise<PreflightDeps>;
  serve: () => Promise<number>;
  write: (text: string) => void;
  writeErr: (text: string) => void;
  color: boolean;
}

export async function iniciarCommand(argv: readonly string[], io: IniciarIo): Promise<number> {
  const opts = parseIniciarArgs(argv);
  if (!opts) {
    io.writeErr(INICIAR_USAGE);
    return 2;
  }
  const deps = await io.deps();
  const checks = await runPreflight({ ...deps, offline: opts.offline || deps.offline });
  const code = preflightExitCode(checks);
  if (opts.json) {
    io.write(`${JSON.stringify({ ok: code === 0, checks }, null, 2)}\n`);
    return code;
  }
  io.write(`${formatPreflight(checks, { color: io.color })}\n`);
  if (code !== 0) {
    io.writeErr('No arranco hasta que se arregle lo marcado con ❌.\n');
    return code;
  }
  if (opts.checkOnly) return 0;
  io.write('\nArrancando Asistenta…\n');
  return io.serve();
}

/** Las dependencias reales. Solo las usa la CLI; los tests pasan las suyas. */
export async function realPreflightDeps(): Promise<PreflightDeps> {
  const [{ statfs }, net, vault, startup, platform, config, provider, mail, pathsMod] =
    await Promise.all([
      import('node:fs/promises'),
      import('node:net'),
      import('./vault.js'),
      import('./startup.js'),
      import('./platform.js'),
      import('./config.js'),
      import('./core/provider.js'),
      import('./mail/status.js'),
      import('./paths.js'),
    ]);
  return {
    nodeVersion: process.version,
    platform: process.platform,
    vaultExists: () => vault.vaultExists(),
    unlock: async () => {
      await vault.unlock();
    },
    vaultGet: (key) => vault.vaultGet(key),
    checkTelegramToken: (token) => startup.checkTelegramToken(token),
    checkProvider: async () => {
      await provider.createProviderHandle(config.loadConfig());
    },
    providerFailureMessage: (error) => startup.startupFailureMessage(error),
    tvReachable: async (host) => {
      // Solo abre y cierra una conexión a los puertos de webOS (3001 cifrado, 3000
      // sin cifrar): no manda ninguna orden ni despierta la tele.
      const probe = (port: number) =>
        new Promise<boolean>((resolve) => {
          const socket = net.connect({ host, port, timeout: 2500 });
          const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
          };
          socket.once('connect', () => done(true));
          socket.once('timeout', () => done(false));
          socket.once('error', () => done(false));
        });
      return (await probe(3001)) || (await probe(3000));
    },
    desktopEnabled: () => platform.desktopEnabled(),
    computerUseEnabled: () => config.loadConfig().computerUse !== false,
    mailStatus: () => mail.mailStatus(),
    freeDiskBytes: async () => {
      pathsMod.ensureDirs();
      const s = await statfs(pathsMod.paths.state);
      return Number(s.bavail) * Number(s.bsize);
    },
  };
}

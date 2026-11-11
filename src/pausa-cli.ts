/**
 * Las piezas «de verdad» de la pausa (ver pausa-pc.ts): los procesos aparte
 * `pa pausa aplicar|levantar|status` con sus dependencias de Windows, y el modo pausa del
 * daemon (`servePausa`): solo Telegram, solo el dueño, solo «Levantar».
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { autostartRepo } from './autostart.js';
import {
  daemonRunState,
  runExe,
  sendOwnerTelegram,
  startDaemonTask,
  windowsExe,
} from './autoupdate-cli.js';
import type { TelegramChannel } from './channels/telegram.js';
import { commandButton } from './channels/telegram-shared.js';
import type { Inbound } from './channels/types.js';
import type { ControlStartup } from './controlled-daemon.js';
import { stopDaemon } from './daemon-control.js';
import { assertNotRunning, installLifecycle } from './lifecycle.js';
import { log } from './log.js';
import {
  LEVANTAR_BUTTON_LABEL,
  LEVANTAR_COMMAND,
  LEVANTAR_LAUNCH_FAILED,
  PAUSA_BUTTON_LABEL,
  PAUSA_COMMAND,
  type PausaHelperDeps,
  type PausaState,
  type ProcesoVisto,
  pausaReply,
  pausedReport,
  readPausa,
  runPausaAplicar,
  runPausaLevantar,
  writeLevantar,
  writePausa,
} from './pausa-pc.js';
import { isOwnerDm } from './vigilante.js';

export const PAUSA_USAGE = 'Uso: pa pausa [status]';

/** «⏸️ Parar todo en el PC» (equivale a escribir /pausa_pc pc: pide confirmación). */
export function pausaPcButtons(): Array<{ label: string; action: string }> {
  const b = commandButton(PAUSA_BUTTON_LABEL, PAUSA_COMMAND, 'pc');
  return b ? [b] : [];
}

/** El botón «▶️ Levantar todo» (equivale a escribir /levantar todo). */
export function levantarButton(): { label: string; action: string } {
  const b = commandButton(LEVANTAR_BUTTON_LABEL, LEVANTAR_COMMAND, 'todo');
  if (!b) throw new Error('botón levantar fuera de la lista de órdenes');
  return b;
}

const POWERSHELL = (): string => windowsExe('WindowsPowerShell', 'v1.0', 'powershell.exe');
const PROCESS_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Dependencias reales (Windows) de los dos procesos aparte. */
export function realPausaDeps(stateDir: string): PausaHelperDeps {
  return {
    stopDaemon: async () => {
      await stopDaemon(stateDir);
    },
    startDaemon: startDaemonTask,
    daemonState: () => daemonRunState(stateDir),
    procesos: async (nombre): Promise<ProcesoVisto[]> => {
      if (!PROCESS_NAME.test(nombre)) return [];
      const r = await runExe(
        POWERSHELL(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-Process -Name '${nombre}' -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $_.Path } else { '-' } }`,
        ],
        20_000,
      );
      return r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((ruta) => ({ nombre, ruta: ruta === '-' ? undefined : ruta }));
    },
    matar: async (nombre) => {
      if (!PROCESS_NAME.test(nombre)) return { ok: false, motivo: 'nombre de proceso raro' };
      const r = await runExe(
        windowsExe('taskkill.exe'),
        ['/IM', `${nombre}.exe`, '/T', '/F'],
        20_000,
      );
      if (!r.error) return { ok: true };
      const out = `${r.stdout}${r.stderr}`;
      return {
        ok: false,
        motivo: /acceso denegado|access is denied/i.test(out)
          ? 'Windows no me deja cerrarlo (se abrió como administrador)'
          : out.replace(/\s+/g, ' ').trim().slice(0, 140) || 'taskkill falló',
      };
    },
    matarHidagent: async () => {
      // Sin WSL (o sin Ubuntu) no hay hidagent: ni se intenta ni sale en el informe.
      const probe = await runExe(
        windowsExe('wsl.exe'),
        ['-d', 'Ubuntu', '--', 'pgrep', '-f', 'python -m hidagent'],
        20_000,
      );
      if (probe.error || !probe.stdout.trim()) return { habia: false, ok: true };
      const r = await runExe(
        windowsExe('wsl.exe'),
        ['-d', 'Ubuntu', '--', 'pkill', '-f', 'python -m hidagent'],
        20_000,
      );
      return r.error
        ? { habia: true, ok: false, motivo: 'pkill en WSL falló' }
        : { habia: true, ok: true };
    },
    lanzar: async (ruta, args) => {
      try {
        const child = spawn(ruta, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        return true;
      } catch {
        return false;
      }
    },
    notify: async (text, buttons) => {
      await sendOwnerTelegram(text, undefined, buttons ?? []);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/** Lanza `pa pausa <accion>` aparte y desligado (sobrevive al daemon que lo lanza). */
export function launchPausaHelper(accion: 'aplicar' | 'levantar'): void {
  const child = spawn(
    process.execPath,
    [join(autostartRepo(), 'dist', 'cli.js'), 'pausa', accion],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.on('error', (err) => log.warn('pausa: el proceso aparte no arrancó', { err: String(err) }));
  child.unref();
}

/** `pa pausa [status|aplicar|levantar]` (aplicar y levantar son internas: las lanza el bot). */
export async function pausaCommand(
  args: string[],
  opts: { stateDir: string; deps?: PausaHelperDeps },
): Promise<number> {
  const action = args[0] ?? 'status';
  if (args.length > 1 || !['status', 'aplicar', 'levantar'].includes(action)) {
    process.stderr.write(`${PAUSA_USAGE}\n`);
    return 2;
  }
  if (action === 'status') {
    const p = readPausa(opts.stateDir);
    process.stdout.write(
      p
        ? `PC en pausa desde ${p.since}. Se levanta desde Telegram con «▶️ Levantar todo» o /levantar.\n`
        : 'Sin pausa: Asistenta funciona normal.\n',
    );
    return 0;
  }
  if (process.platform !== 'win32' && !opts.deps) {
    process.stderr.write('pa pausa aplicar/levantar solo funciona en Windows.\n');
    return 2;
  }
  const deps = opts.deps ?? realPausaDeps(opts.stateDir);
  return action === 'aplicar'
    ? runPausaAplicar(opts.stateDir, deps, levantarButton())
    : runPausaLevantar(opts.stateDir, deps);
}

export interface ServePausaOptions {
  stateDir: string;
  token: string;
  allowed: number[];
  ownerId: number | null;
  control?: ControlStartup;
  /** Solo tests. */
  channel?: Pick<TelegramChannel, 'start' | 'stop' | 'send' | 'account'>;
  launch?: (accion: 'levantar') => void;
  timeZone?: string;
}

/**
 * El daemon en modo pausa: Telegram para el dueño y nada más (ni modelo, ni rutinas, ni
 * micrófono, ni panel, ni navegadores). Vive hasta que `pa pausa levantar` lo cierra.
 */
/**
 * En pausa, lo que Nico manda a secas (un enlace, un PDF, una captura, «libro: …») se guarda
 * en la bandeja SIN procesarlo: nada de transcribir ni de llamar al modelo con el PC parado.
 * Al levantar, el daemon normal lo retoma solo (BandejaQueue.resume, lo «nuevo»). Antes se
 * contestaba «estoy en pausa» y el enlace se perdía. null = no es para la bandeja.
 */
export async function guardarEnPausa(
  stateDir: string,
  inbound: Inbound,
  now: Date = new Date(),
): Promise<string | null> {
  if (inbound.channel !== 'telegram') return null;
  const { detectCapture } = await import('./bandeja/captura.js');
  const { captureOn } = await import('./bandeja/comando.js');
  const { BandejaStore } = await import('./bandeja/store.js');
  const { localDay } = await import('./datecontext.js');
  const store = new BandejaStore(join(stateDir, 'bandeja.db'));
  try {
    const cands = detectCapture(inbound, { auto: captureOn(store) });
    if (!cands?.length) return null;
    const day = localDay(now);
    const saved = cands.map((c) => store.add(inbound.chatId, c, now, day));
    // Lo que ya estaba pero falló (⚠️): mandarlo otra vez es pedir otro intento, como fuera
    // de la pausa (#2306). Vuelve a «nuevo» para que la cola lo retome al levantar; antes
    // contestaba «Eso ya estaba» y no se reintentaba nunca.
    const retry = saved.filter((s) => s.dup && s.item.status === 'error');
    for (const s of retry) store.setStatus(s.item.id, 'nuevo');
    const n = store.countDay(inbound.chatId, day);
    const levantar = `Estoy en pausa: lo miro cuando pulses «${LEVANTAR_BUTTON_LABEL}».`;
    if (saved.every((s) => s.dup)) {
      if (retry.length) return `📥 Eso había fallado (⚠️): lo vuelvo a intentar. ${levantar}`;
      return `📥 Eso ya estaba en la bandeja (${n} hoy).`;
    }
    return `📥 Guardado en la bandeja (${n} hoy). ${levantar}`;
  } finally {
    store.close();
  }
}

export async function servePausa(opts: ServePausaOptions): Promise<number> {
  const { stateDir } = opts;
  assertNotRunning(stateDir, 'agent');
  opts.control?.beginResources();
  // grammY solo al arrancar el canal (rend4): `pa ayuda` y `pa pausa status` no lo cargan.
  const telegram =
    opts.channel ??
    new (await import('./channels/telegram.js')).TelegramChannel({
      token: opts.token,
      allowedUserIds: opts.allowed,
    });
  const launch = opts.launch ?? launchPausaHelper;
  let levantando = false;
  const say = (inbound: Inbound, text: string, conBoton: boolean) =>
    telegram
      .send({
        channel: 'telegram',
        account: telegram.account,
        chatId: inbound.chatId,
        threadId: inbound.threadId,
        text,
        buttons: conBoton ? [levantarButton()] : undefined,
      })
      .catch((err: unknown) => log.warn('pausa: respuesta no enviada', { err: String(err) }));

  const onMessage = async (inbound: Inbound): Promise<void> => {
    const state = readPausa(stateDir);
    if (!state) return; // ya la levantaron: el daemon normal está a punto de llegar
    const r = pausaReply(
      { text: inbound.text ?? '', isOwnerDm: isOwnerDm(inbound, opts.ownerId) },
      state,
      Date.now(),
      opts.timeZone,
    );
    if (r.kind === 'ignore') return;
    if (r.kind === 'reply') {
      // Un enlace o un PDF a secas: a la bandeja, para cuando se levante.
      const saved = await guardarEnPausa(stateDir, inbound).catch((err: unknown) => {
        log.warn('pausa: no guardé en la bandeja', { err: String(err) });
        return null;
      });
      if (saved) {
        await say(inbound, saved, true);
        return;
      }
      await say(inbound, r.text, r.levantar);
      return;
    }
    if (levantando) {
      await say(
        inbound,
        'Ya lo estoy levantando: te aviso aquí con el estado de cada pieza.',
        false,
      );
      return;
    }
    levantando = true;
    writeLevantar(stateDir, {
      at: new Date().toISOString(),
      externos: state.externos ?? [],
      hidagent: state.hidagent,
    });
    try {
      launch('levantar');
    } catch (err) {
      levantando = false;
      log.warn('pausa: no pude lanzar levantar', { err: String(err) });
      await say(inbound, LEVANTAR_LAUNCH_FAILED, true);
      return;
    }
    await say(
      inbound,
      '▶️ Levantando todo… Me cierro un momento, arranco lo que tenías configurado y te digo aquí cómo responde cada pieza (tarda 1–2 minutos).',
      false,
    );
  };

  const lifecycle = installLifecycle({
    name: 'agent',
    stateDir,
    onShutdown: async () => {
      await telegram.stop(true).catch(() => {});
      log.info('modo pausa: cerrado');
    },
  });
  opts.control?.attach(lifecycle);
  await telegram.start({
    onMessage,
    log: (level, msg, fields) => log[level](msg, fields),
  });
  const state = readPausa(stateDir);
  if (state && !state.avisado && opts.ownerId) {
    await telegram
      .send({
        channel: 'telegram',
        account: telegram.account,
        chatId: String(opts.ownerId),
        text: pausedReport(state),
        buttons: [levantarButton()],
      })
      .then(() => writePausa(stateDir, { ...state, avisado: true } satisfies PausaState))
      .catch((err: unknown) => log.warn('pausa: informe no enviado', { err: String(err) }));
  }
  opts.control?.ready();
  log.info('modo pausa: solo Telegram, esperando «Levantar»');
  await lifecycle.done;
  return 0;
}

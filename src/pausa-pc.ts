/**
 * «⏸️ Parar todo en el PC» / «▶️ Levantar todo» desde Telegram (Nico, 9-nov-2026: «botón
 * asistenta telegram que pare todo lo del pc y luego que lo pueda levantar otra vez»;
 * regla suya: todo por Telegram, sin tocar el portátil).
 *
 * Cómo para «todo» sin dejar el chat sordo:
 * - El daemon pide confirmación con un botón y, al confirmar, apunta la pausa en
 *   `<estado>/pausa-pc.json` y lanza aparte `pa pausa aplicar`.
 * - Ese proceso cierra el daemon por el camino limpio de siempre (el mismo de `pa stop`:
 *   cancela los turnos en curso, rutinas, vigilante, micrófono, panel, navegadores,
 *   tele, correo…), cierra lo que vive fuera del daemon (UxPlay, el ayudante Bluetooth
 *   del iPhone, hidagent en WSL) y vuelve a arrancar la tarea del daemon.
 * - Con la pausa apuntada el daemon arranca en MODO PAUSA (`servePausa`): solo Telegram,
 *   solo el dueño en privado, solo «Levantar» y «estado». Nada más se abre. Si el PC se
 *   reinicia, la tarea de inicio vuelve a arrancar en modo pausa hasta que pulse Levantar.
 * - «Levantar» apunta `levantar-pc.json` y lanza `pa pausa levantar`: cierra el modo pausa,
 *   borra la pausa, relanza lo de fuera que estaba en marcha y arranca el daemon normal,
 *   que lee su .env como en cualquier arranque (así vuelve exactamente lo configurado) y,
 *   al estar listo, comprueba cada pieza y manda su estado.
 *
 * Parar el bot entero NO forma parte del botón: desde Telegram no se podría levantar.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileReplacing } from './fs-tmp.js';

export const PAUSA_FILE = 'pausa-pc.json';
export const LEVANTAR_FILE = 'levantar-pc.json';

export const PAUSA_BUTTON_LABEL = '⏸️ Parar todo en el PC';
export const LEVANTAR_BUTTON_LABEL = '▶️ Levantar todo';
/** Las órdenes de los botones (src/channels/telegram-shared.ts, lista cerrada). */
export const PAUSA_COMMAND = 'pausa_pc';
export const LEVANTAR_COMMAND = 'levantar';
/** Cuánto vale el botón «Sí, parar todo» después de enseñarlo. */
export const CONFIRM_TTL_MS = 5 * 60_000;
/** Cuánto se espera a que el daemon (normal o en pausa) vuelva a estar en marcha. */
export const RESTART_WAIT_MS = 180_000;
/** Tope por comprobación al levantar. */
export const CHECK_TIMEOUT_MS = 10_000;

export const OWNER_ONLY = 'Esto solo lo puede hacer el dueño, en su chat privado conmigo.';
export const NOT_WINDOWS =
  'Parar y levantar todo desde Telegram solo funciona en el PC con Windows (necesita la tarea de inicio para volver a arrancar).';
export const CONFIRM_STALE =
  'Ese botón ya no vale (caduca a los 5 minutos). Escribe /pausa_pc para pedirlo otra vez.';
export const CANCELLED = 'Vale, no paro nada. Todo sigue en marcha.';
export const LAUNCH_FAILED =
  'No he podido lanzar el proceso que para todo, así que no he parado nada. Mira el log de Asistenta.';
export const LEVANTAR_LAUNCH_FAILED =
  'No he podido lanzar el proceso que lo levanta todo: sigo en pausa. Prueba otra vez en un minuto.';

/** Lo que vive FUERA del proceso del daemon y por tanto no cierra su apagado. */
export interface Externo {
  id: string;
  nombre: string;
  /** Nombre del proceso de Windows, sin .exe. */
  proceso: string;
  /**
   * Si al levantar se vuelve a lanzar con su ruta. El ayudante Bluetooth no: lo abre el
   * daemon la primera vez que se usa el iPhone (PA_IPHONE_BLE=1).
   */
  relanzarArgs?: string[];
}

export const EXTERNOS: readonly Externo[] = [
  {
    id: 'uxplay',
    nombre: 'UxPlay (pantalla del iPhone)',
    proceso: 'uxplay',
    // Los mismos con los que lo abre deploy/iphone/windows/preparar-windows.ps1 (con -Arrancar).
    relanzarArgs: ['-n', 'Asistenta', '-nh'],
  },
  { id: 'hid', nombre: 'ayudante Bluetooth del iPhone', proceso: 'AsistentaHid' },
];

/** hidagent (puente del ESP32) corre dentro de WSL con deploy/iphone/run.sh. */
export const HIDAGENT_NOMBRE = 'hidagent (puente del ESP32, en WSL)';

export interface Resultado {
  nombre: string;
  ok: boolean;
  /** Motivo si no se pudo, o detalle si sí. */
  detalle?: string;
}

export interface ExternoVisto {
  id: string;
  ruta?: string;
}

export interface PausaState {
  since: string;
  /** Lo que estaba en marcha dentro del daemon al pedir la pausa (para el informe). */
  activo: string[];
  /** Lo de fuera que estaba en marcha (para relanzarlo igual al levantar). */
  externos?: ExternoVisto[];
  /** hidagent estaba en marcha en WSL al parar (no se relanza solo: ver la guía). */
  hidagent?: boolean;
  /** Lo que escribe `pa pausa aplicar`. */
  resultado?: Resultado[];
  /** El modo pausa ya mandó el informe de lo parado. */
  avisado?: boolean;
}

export interface LevantarState {
  at: string;
  externos: ExternoVisto[];
  hidagent?: boolean;
  /** Lo que escribe `pa pausa levantar` antes de arrancar el daemon normal. */
  resultado?: Resultado[];
}

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

function writeJson(stateDir: string, name: string, value: unknown): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileReplacing(join(stateDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * La pausa apuntada, o null. Un fichero ilegible CUENTA como pausa (con lo mínimo): ante
 * la duda se queda parado, que es lo que Nico pidió, y «Levantar» lo arregla.
 */
export function readPausa(stateDir: string): PausaState | null {
  const file = join(stateDir, PAUSA_FILE);
  if (!existsSync(file)) return null;
  const v = readJson<Partial<PausaState>>(file);
  return {
    since: typeof v?.since === 'string' ? v.since : new Date(0).toISOString(),
    activo: Array.isArray(v?.activo) ? v.activo.filter((s) => typeof s === 'string') : [],
    externos: Array.isArray(v?.externos) ? v.externos : [],
    hidagent: v?.hidagent === true,
    resultado: Array.isArray(v?.resultado) ? v.resultado : undefined,
    avisado: v?.avisado === true,
  };
}

export function writePausa(stateDir: string, state: PausaState): void {
  writeJson(stateDir, PAUSA_FILE, state);
}

export function clearPausa(stateDir: string): void {
  rmSync(join(stateDir, PAUSA_FILE), { force: true });
}

export function readLevantar(stateDir: string): LevantarState | null {
  const v = readJson<Partial<LevantarState>>(join(stateDir, LEVANTAR_FILE));
  if (!v) return null;
  return {
    at: typeof v.at === 'string' ? v.at : new Date().toISOString(),
    externos: Array.isArray(v.externos) ? v.externos : [],
    hidagent: v.hidagent === true,
    resultado: Array.isArray(v.resultado) ? v.resultado : undefined,
  };
}

export function writeLevantar(stateDir: string, state: LevantarState): void {
  writeJson(stateDir, LEVANTAR_FILE, state);
}

export function clearLevantar(stateDir: string): void {
  rmSync(join(stateDir, LEVANTAR_FILE), { force: true });
}

// ---------------------------------------------------------------------------
// Textos

function lista(items: string[]): string {
  return items.map((s) => `• ${s}`).join('\n');
}

/** El mensaje que pide confirmación. */
export function confirmText(activo: string[]): string {
  return [
    '⏸️ ¿Paro todo lo de Asistenta en el PC?',
    '',
    activo.length > 0
      ? `Ahora mismo está en marcha:\n${lista(activo)}`
      : 'Ahora mismo no hay nada en marcha aparte de mí.',
    '',
    'Paro también UxPlay, el ayudante Bluetooth del iPhone y hidagent si están abiertos, y cancelo lo que esté a medias.',
    'Telegram sigue vivo (solo para ti) para que puedas pulsar «▶️ Levantar todo». Si el PC se reinicia, sigo en pausa hasta que lo pulses.',
  ].join('\n');
}

/** Lo que dice el modo pausa al arrancar tras `pa pausa aplicar`. */
export function pausedReport(state: PausaState): string {
  const res = state.resultado ?? [];
  const bien = res
    .filter((r) => r.ok)
    .map((r) => (r.detalle ? `${r.nombre} (${r.detalle})` : r.nombre));
  const mal = res.filter((r) => !r.ok).map((r) => `${r.nombre}: ${r.detalle ?? 'sin motivo'}`);
  const out = ['⏸️ PC en pausa.'];
  if (bien.length > 0) out.push('', `Parado:\n${lista(bien)}`);
  if (mal.length > 0) out.push('', `No se pudo parar:\n${lista(mal)}`);
  if (res.length === 0)
    out.push(
      '',
      'No tengo el detalle de lo parado (el PC se reinició a medias), pero ahora no corre nada aparte de este chat.',
    );
  out.push('', 'Solo sigo escuchando aquí. Pulsa «▶️ Levantar todo» para volver.');
  return out.join('\n');
}

export function pausedReplyText(state: PausaState, now: number, timeZone?: string): string {
  const since = Date.parse(state.since);
  const when =
    Number.isFinite(since) && since > 0
      ? new Date(since).toLocaleString('es-ES', {
          timeZone,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;
  const mins =
    Number.isFinite(since) && since > 0 ? Math.max(0, Math.round((now - since) / 60_000)) : null;
  return [
    `⏸️ Estoy en pausa${when ? ` desde el ${when}${mins !== null ? ` (hace ${mins} min)` : ''}` : ''}: todo lo del PC está parado y no hago nada más.`,
    'Pulsa «▶️ Levantar todo» (o escribe /levantar) para volver.',
  ].join('\n');
}

export function levantadoReport(res: Resultado[]): string {
  const bien = res.filter((r) => r.ok);
  const mal = res.filter((r) => !r.ok);
  const linea = (r: Resultado) =>
    `${r.ok ? '✅' : '❌'} ${r.nombre}${r.detalle ? `: ${r.detalle}` : ''}`;
  const head =
    mal.length === 0
      ? '▶️ Todo levantado y respondiendo.'
      : `▶️ Levantado, pero ${mal.length === 1 ? 'una pieza no responde' : `${mal.length} piezas no responden`}.`;
  return [head, '', ...bien.map(linea), ...mal.map(linea)].join('\n');
}

// ---------------------------------------------------------------------------
// Confirmación (en el daemon normal)

export interface ConfirmDeps {
  isOwnerDm: boolean;
  platform: NodeJS.Platform;
  now(): number;
  nonce(): string;
}

export type PausaDecision =
  | { kind: 'reply'; text: string }
  | { kind: 'ask'; text: string; nonce: string }
  | { kind: 'go' };

/**
 * Qué hacer con `/pausa_pc [pc | confirmar <n> | cancelar <n>]`. Una por daemon: recuerda
 * el último botón de confirmación enseñado (solo ese vale, 5 minutos).
 */
export function createPausaConfirm(): (
  args: string,
  activo: string[],
  deps: ConfirmDeps,
) => PausaDecision {
  let pending: { nonce: string; until: number } | null = null;
  return (args, activo, deps) => {
    if (!deps.isOwnerDm) return { kind: 'reply', text: OWNER_ONLY };
    if (deps.platform !== 'win32') return { kind: 'reply', text: NOT_WINDOWS };
    const [sub = '', arg = ''] = args.trim().split(/\s+/);
    if (sub === 'confirmar' || sub === 'cancelar') {
      const valid = pending !== null && pending.nonce === arg && deps.now() <= pending.until;
      if (!valid) return { kind: 'reply', text: CONFIRM_STALE };
      pending = null;
      return sub === 'cancelar' ? { kind: 'reply', text: CANCELLED } : { kind: 'go' };
    }
    const nonce = deps.nonce();
    pending = { nonce, until: deps.now() + CONFIRM_TTL_MS };
    return { kind: 'ask', text: confirmText(activo), nonce };
  };
}

// ---------------------------------------------------------------------------
// Los dos procesos aparte: `pa pausa aplicar` y `pa pausa levantar`

export interface ProcesoVisto {
  nombre: string;
  ruta?: string;
}

export interface PausaHelperDeps {
  /** Cierre limpio del daemon (control local), sin marcarlo «parado a propósito». */
  stopDaemon(): Promise<void>;
  /** Arranca la tarea del daemon (la misma del inicio de Windows). */
  startDaemon(): Promise<boolean>;
  daemonState(): 'running' | 'stopped' | 'unknown';
  /** Procesos de Windows con ese nombre (sin .exe) y su ruta. */
  procesos(nombre: string): Promise<ProcesoVisto[]>;
  /** Cierra todos los procesos con ese nombre (y sus hijos). */
  matar(nombre: string): Promise<{ ok: boolean; motivo?: string }>;
  /** hidagent en WSL: si había y si se paró. `habia: false` si no hay WSL o no corría. */
  matarHidagent(): Promise<{ habia: boolean; ok: boolean; motivo?: string }>;
  lanzar(ruta: string, args: string[]): Promise<boolean>;
  notify(text: string, buttons?: Array<{ label: string; action: string }>): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function reason(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/\s+/g, ' ').slice(0, 160) || 'error sin texto';
}

async function waitRunning(deps: PausaHelperDeps, maxMs: number): Promise<boolean> {
  const until = deps.now() + maxMs;
  let nextKick = deps.now();
  while (deps.now() < until) {
    if (deps.daemonState() === 'running') return true;
    if (deps.now() >= nextKick) {
      await deps.startDaemon().catch(() => false);
      nextKick = deps.now() + 20_000;
    }
    await deps.sleep(2_000);
  }
  return deps.daemonState() === 'running';
}

async function waitStopped(deps: PausaHelperDeps, maxMs: number): Promise<boolean> {
  const until = deps.now() + maxMs;
  while (deps.now() < until) {
    if (deps.daemonState() !== 'running') return true;
    await deps.sleep(1_000);
  }
  return deps.daemonState() !== 'running';
}

/** Botón de levantar (lo construye quien llama con commandButton, para no importar canales aquí). */
export type Boton = { label: string; action: string };

/**
 * `pa pausa aplicar`: para el daemon normal y lo de fuera, y deja arrancado el modo pausa.
 * Devuelve 0 si quedó en pausa.
 */
export async function runPausaAplicar(
  stateDir: string,
  deps: PausaHelperDeps,
  levantarBoton?: Boton,
): Promise<number> {
  const state = readPausa(stateDir);
  if (!state) return 0; // nadie la pidió (o ya se levantó): nada que hacer
  // El turno que la pidió acaba de contestar «parando…»: un respiro para que salga.
  await deps.sleep(1_500);
  const resultado: Resultado[] = [];
  const vistos: ExternoVisto[] = [];
  for (const ext of EXTERNOS) {
    const ps = await deps.procesos(ext.proceso).catch(() => []);
    if (ps.length > 0) vistos.push({ id: ext.id, ruta: ps.find((p) => p.ruta)?.ruta });
  }
  try {
    await deps.stopDaemon();
    if (!(await waitStopped(deps, 30_000))) throw new Error('seguía en marcha 30 s después');
  } catch (err) {
    // Sin daemon parado no hay pausa: se borra y todo sigue como estaba.
    clearPausa(stateDir);
    await deps
      .notify(
        `No he podido parar Asistenta (${reason(err)}), así que no he parado nada: todo sigue en marcha.`,
      )
      .catch(() => {});
    return 1;
  }
  const dentro = state.activo.length > 0 ? state.activo.join(', ') : 'nada en marcha';
  resultado.push({
    nombre: 'Asistenta por dentro',
    ok: true,
    detalle: `cerrada limpia: ${dentro}`,
  });
  for (const ext of EXTERNOS) {
    if (!vistos.some((v) => v.id === ext.id)) continue;
    const r = await deps
      .matar(ext.proceso)
      .catch((err: unknown) => ({ ok: false, motivo: reason(err) }));
    const quedan = r.ok ? await deps.procesos(ext.proceso).catch(() => []) : [];
    if (r.ok && quedan.length === 0) resultado.push({ nombre: ext.nombre, ok: true });
    else
      resultado.push({
        nombre: ext.nombre,
        ok: false,
        detalle: r.motivo ?? 'sigue abierto (quizá se abrió como administrador)',
      });
  }
  const hid = await deps
    .matarHidagent()
    .catch((err: unknown) => ({ habia: true, ok: false, motivo: reason(err) }));
  if (hid.habia)
    resultado.push({
      nombre: HIDAGENT_NOMBRE,
      ok: hid.ok,
      detalle: hid.ok ? undefined : hid.motivo,
    });
  writePausa(stateDir, {
    ...state,
    externos: vistos,
    hidagent: hid.habia && hid.ok,
    resultado,
    avisado: false,
  });
  if (await waitRunning(deps, RESTART_WAIT_MS)) return 0;
  // El modo pausa no arrancó: este proceso es el único que puede decirlo.
  await deps
    .notify(
      'He parado todo, pero no consigo arrancar el modo pausa (el que escucha «Levantar»). El vigilante de Windows lo reintenta cada 5 minutos; si no vuelvo, reinicia el PC.',
      levantarBoton ? [levantarBoton] : undefined,
    )
    .catch(() => {});
  return 1;
}

/**
 * `pa pausa levantar`: cierra el modo pausa, borra la pausa, relanza lo de fuera que
 * estaba en marcha y arranca el daemon normal (que comprueba sus piezas al estar listo).
 */
export async function runPausaLevantar(stateDir: string, deps: PausaHelperDeps): Promise<number> {
  const lev = readLevantar(stateDir);
  if (!lev) return 0;
  await deps.sleep(1_500);
  try {
    await deps.stopDaemon();
    if (!(await waitStopped(deps, 30_000))) throw new Error('seguía en marcha 30 s después');
  } catch (err) {
    clearLevantar(stateDir);
    await deps
      .notify(
        `No he podido cerrar el modo pausa (${reason(err)}): sigo en pausa. Prueba otra vez en un minuto.`,
      )
      .catch(() => {});
    return 1;
  }
  clearPausa(stateDir);
  const resultado: Resultado[] = [];
  for (const visto of lev.externos) {
    const ext = EXTERNOS.find((e) => e.id === visto.id);
    if (!ext) continue;
    if (!ext.relanzarArgs) {
      resultado.push({ nombre: ext.nombre, ok: true, detalle: 'lo abro yo al usar el iPhone' });
      continue;
    }
    if (!visto.ruta) {
      resultado.push({
        nombre: ext.nombre,
        ok: false,
        detalle:
          'no sé desde dónde se abrió; ábrelo con: powershell -ExecutionPolicy Bypass -File deploy\\iphone\\windows\\preparar-windows.ps1 -Arrancar',
      });
      continue;
    }
    const ok = await deps.lanzar(visto.ruta, ext.relanzarArgs).catch(() => false);
    let vivo = false;
    if (ok) {
      for (let i = 0; i < 5 && !vivo; i++) {
        await deps.sleep(1_000);
        vivo = (await deps.procesos(ext.proceso).catch(() => [])).length > 0;
      }
    }
    resultado.push({
      nombre: ext.nombre,
      ok: vivo,
      detalle: vivo ? 'abierto otra vez' : 'no se quedó abierto',
    });
  }
  if (lev.hidagent)
    resultado.push({
      nombre: HIDAGENT_NOMBRE,
      ok: false,
      detalle: 'no lo relanzo: va en WSL con su terminal (bash deploy/iphone/run.sh)',
    });
  writeLevantar(stateDir, { ...lev, resultado });
  if (await waitRunning(deps, RESTART_WAIT_MS)) return 0;
  await deps
    .notify(
      'He quitado la pausa pero Asistenta no termina de arrancar. El vigilante de Windows lo reintenta cada 5 minutos; si no vuelvo, reinicia el PC.',
    )
    .catch(() => {});
  return 1;
}

// ---------------------------------------------------------------------------
// Comprobaciones al levantar (en el daemon normal, ya listo)

export interface Comprobacion {
  nombre: string;
  comprobar(): Promise<{ ok: boolean; detalle?: string }>;
}

export async function comprobarPiezas(
  checks: Comprobacion[],
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<Resultado[]> {
  return Promise.all(
    checks.map(async (c) => {
      let timer: NodeJS.Timeout | undefined;
      const tope = new Promise<{ ok: boolean; detalle?: string }>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({ ok: false, detalle: `no respondió en ${Math.round(timeoutMs / 1000)} s` }),
          timeoutMs,
        );
        timer.unref?.();
      });
      try {
        const r = await Promise.race([c.comprobar(), tope]);
        return { nombre: c.nombre, ok: r.ok, detalle: r.detalle };
      } catch (err) {
        return { nombre: c.nombre, ok: false, detalle: reason(err) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}

/** Lo que el daemon normal hace tras arrancar si viene de «Levantar». */
export async function informarLevantado(
  stateDir: string,
  checks: Comprobacion[],
  send: (text: string) => Promise<unknown>,
): Promise<boolean> {
  const lev = readLevantar(stateDir);
  if (!lev) return false;
  clearLevantar(stateDir);
  const res = [...(await comprobarPiezas(checks)), ...(lev.resultado ?? [])];
  await send(levantadoReport(res));
  return true;
}

// ---------------------------------------------------------------------------
// Modo pausa: qué contesta a cada mensaje

export type PausaReply =
  | { kind: 'ignore' }
  | { kind: 'reply'; text: string; levantar: boolean }
  | { kind: 'levantar' };

/** El dueño en privado: «/levantar», el botón o «levanta(r) todo»; lo demás, el aviso. */
export function pausaReply(
  m: { text: string; isOwnerDm: boolean },
  state: PausaState,
  now: number,
  timeZone?: string,
): PausaReply {
  if (!m.isOwnerDm) return { kind: 'ignore' };
  const t = m.text.trim().toLowerCase();
  if (/^\/levantar(@\w+)?(\s+todo)?$/.test(t) || /^levanta(r)?( todo)?[.!]*$/.test(t))
    return { kind: 'levantar' };
  return { kind: 'reply', text: pausedReplyText(state, now, timeZone), levantar: true };
}

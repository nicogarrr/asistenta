import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../config.js';
import { isGoogleEndpoint, isOpenCodeEndpoint, isOpenRouterEndpoint } from '../core/provider.js';
import { wallClock } from '../datecontext.js';
import { envSecretName, vaultGet } from '../vault.js';

import { Archive, isoWeek } from './archive.js';
import {
  BATTERY_FILE,
  type BatteryRun,
  type BatteryRunner,
  cycleOfWeek,
  gateFromFile,
  heavyRotation,
  unscored,
} from './battery-gate.js';
import { HISTORY_DIR, quarantinedCases, recordBaseWeek } from './battery-history.js';
import { loadBattery, type Trace } from './battery-judge.js';
import { type EvolveOptions, runWeek, summarize, type WeekReport } from './loop.js';
import { cleanEnv } from './measure.js';
import { repoRoot } from './worktree.js';

/**
 * What the app calls: the weekly trigger, the /evolucion command and the proposer.
 *
 * The loop in loop.ts is pure plumbing. This file is the only place that knows where the
 * state lives, how a model is asked for a patch and when the week is due, so the loop stays
 * testable without a model, a clock or Telegram.
 */

const exec = promisify(execFile);

/** Sunday from 03:00 local, once every 6 days: the machine is idle and the owner is asleep. */
export function isEvolveDue(now: Date, lastRunMs: number): boolean {
  return (
    wallClock(now).weekday === 0 &&
    wallClock(now).hour >= 3 &&
    now.getTime() - lastRunMs > 6 * 24 * 3_600_000
  );
}

function hypothesesFile(stateDir: string): string {
  return join(stateDir, 'evolve', 'hipotesis.txt');
}

/** One idea per line. Added with `/evolucion idea <texto>`, read by the next cycle. */
export function addHypothesis(stateDir: string, text: string): void {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) throw new Error('la idea está vacía');
  mkdirSync(join(stateDir, 'evolve'), { recursive: true });
  appendFileSync(hypothesesFile(stateDir), `${clean}\n`, 'utf8');
}

export function readHypotheses(stateDir: string): string[] {
  try {
    return readFileSync(hypothesesFile(stateDir), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The proposer is an operator-configured program (PA_EVOLVE_PROPOSER): it runs inside the
 * sandbox directory, is told the idea and the attempt number in its environment, and edits
 * files there. It is not the candidate: it may use the model credentials, the candidate
 * code never does (see measure.ts).
 */
/**
 * What the proposer inherits: the minimum to run, plus ONLY the variables the operator names
 * in PA_EVOLVE_PROPOSER_PASS (comma-separated, e.g. the model key it needs). Not the whole
 * environment, and not the user's home, so it does not inherit HOME or other keys
 * (it can still open absolute paths: same OS user). The idea text (PA_EVOLVE_HYPOTHESIS) comes from /evolucion idea, so it is
 * untrusted input to the proposer; the guard checks what it writes, not what it was told.
 */
export function proposerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = cleanEnv(env);
  for (const name of (env.PA_EVOLVE_PROPOSER_PASS ?? '').split(',')) {
    const k = name.trim();
    if (k && env[k] !== undefined) out[k] = env[k];
  }
  return out;
}

export function proposerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EvolveOptions['propose'] | null {
  const cmd = env.PA_EVOLVE_PROPOSER?.trim();
  if (!cmd) return null;
  return async (dir, hypothesis, attempt) => {
    await exec(cmd, [], {
      cwd: dir,
      timeout: 30 * 60_000,
      windowsHide: true,
      shell: false,
      env: {
        ...proposerEnv(env),
        PA_EVOLVE_DIR: dir,
        PA_EVOLVE_HYPOTHESIS: hypothesis,
        PA_EVOLVE_ATTEMPT: String(attempt),
      },
    });
  };
}

/** Lee la traza que imprime el evaluador: la última línea JSON de su salida. Estricto. */
export function parseTrace(stdout: string): Trace {
  const line = stdout.trim().split('\n').pop() ?? '';
  const t = JSON.parse(line) as Trace;
  if (
    typeof t?.reply !== 'string' ||
    !Array.isArray(t.toolCalls) ||
    typeof t.approvalsAsked !== 'number'
  )
    throw new Error('traza inválida');
  return t;
}

/**
 * Qué secreto del almacén usa el modelo para ese endpoint (la misma elección que
 * resolveApiKey en core/provider.ts). Un endpoint propio no lee el almacén (PA_API_KEY), así
 * que no hay nada que pasar: null.
 */
export function modelKeyName(baseUrl: string): string | null {
  if (isOpenRouterEndpoint(baseUrl)) return 'provider:openrouterKey';
  if (isGoogleEndpoint(baseUrl)) return 'provider:geminiKey';
  if (!isOpenCodeEndpoint(baseUrl)) return null;
  return 'provider:apiKey';
}

/** Qué modelo usa el asistente: el evaluador mide con el mismo (no son secretos). */
const MODEL_CONFIG_VARS = ['PA_PROVIDER_PRESET', 'PA_PROVIDER', 'PA_MODEL', 'PA_BASE_URL'];

export interface ModelKeyDeps {
  /** Lee un secreto del almacén real (por defecto vaultGet, en el proceso del asistente). */
  readSecret?: (key: string) => Promise<string | undefined>;
  /** El endpoint del modelo (por defecto el de la configuración del asistente). */
  baseUrl?: () => string;
}

/**
 * Lo que el evaluador por defecto necesita para hablar con el modelo, sin que Nico configure
 * nada: la elección de modelo y UNA clave, la del modelo, leída aquí del almacén real y
 * entregada al hijo como variable PA_SECRET_<CLAVE> (el almacén por variables que usa su
 * carpeta temporal). Solo vive en memoria y en el entorno del hijo: nunca se escribe a disco
 * ni se registra. Si PA_SECRET_<CLAVE> ya está definida, esa gana (anulación manual).
 */
export async function modelKeyEnv(
  env: NodeJS.ProcessEnv,
  deps: ModelKeyDeps = {},
): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = {};
  for (const k of MODEL_CONFIG_VARS) if (env[k]?.trim()) out[k] = env[k];
  let name: string | null;
  try {
    name = modelKeyName((deps.baseUrl ?? (() => loadConfig().baseUrl))());
  } catch {
    return out;
  }
  if (!name) return out;
  const manual = env[envSecretName(name)];
  const value = manual || (await (deps.readSecret ?? vaultGet)(name).catch(() => undefined));
  if (value) out[envSecretName(name)] = value;
  return out;
}

/** Evaluador por defecto: el script del propio código que se mide (scripts/evolve-battery-case.mjs). */
export const DEFAULT_BATTERY_SCRIPT = join('scripts', 'evolve-battery-case.mjs');

/**
 * PA_EVOLVE_BATTERY: comando que ejecuta UN caso de la batería contra el código de su
 * carpeta (cwd) y escribe la traza como JSON. El caso llega en PA_BATTERY_CASE. Igual que
 * el proponedor, recibe el entorno limpio: nada de claves salvo PA_EVOLVE_PROPOSER_PASS.
 * Sin definir se usa el script del repo con este mismo Node (datos temporales, sin cuentas
 * reales); `off` o `0` lo apagan y entonces ningún cambio se aprueba.
 */
export function batteryRunnerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: ModelKeyDeps = {},
): BatteryRunner | null {
  const raw = env.PA_EVOLVE_BATTERY?.trim() ?? '';
  if (/^(off|0|no|false)$/i.test(raw)) return null;
  const [file, args] = raw ? [raw, [] as string[]] : [process.execPath, [DEFAULT_BATTERY_SCRIPT]];
  return async (c, cwd) => {
    // Solo el evaluador del repo recibe la clave: es el que usa el almacén por variables.
    const key = raw ? {} : await modelKeyEnv(env, deps);
    const { stdout } = await exec(file, args, {
      cwd,
      timeout: 10 * 60_000,
      windowsHide: true,
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...proposerEnv(env), ...key, PA_BATTERY_CASE: JSON.stringify(c) },
    });
    return parseTrace(String(stdout));
  };
}

/** La última nota de la batería que se midió, en una línea. */
function lastBattery(rows: ReturnType<Archive['read']>): string {
  const last = [...rows].reverse().find((r) => r.battery);
  if (!last?.battery) return 'Batería: todavía no se ha medido ningún candidato.';
  const b = last.battery;
  return `Última batería (${last.week}): ${b.passed}/${b.total} casos; el kernel tenía ${b.basePassed}/${b.baseTotal}.`;
}

/** Cuántos casos de la batería no cuentan en la nota, y por qué, en una línea. */
export function notCounting(stateDir: string, file = join(repoRoot(), BATTERY_FILE)): string {
  try {
    const b = loadBattery(file);
    const off = unscored(b, quarantinedCases(join(stateDir, HISTORY_DIR), b.cases));
    if (off.length === 0) return `Casos que no cuentan: ninguno (los ${b.cases.length} puntúan).`;
    const n = (re: RegExp) => off.filter((x) => re.test(x.why)).length;
    const parts = [
      [n(/^desactivado/), 'desactivados'],
      [n(/^servicio externo/), 'apartados por webs que fallan 3 semanas'],
      [n(/^sin criterio/), 'sin criterio de máquina'],
    ]
      .filter(([k]) => (k as number) > 0)
      .map(([k, what]) => `${k} ${what}`);
    return `Casos que no cuentan: ${off.length} de ${b.cases.length} (${parts.join(', ')}).`;
  } catch {
    return 'Casos que no cuentan: no se pudo leer la batería.';
  }
}

/** Qué casos pesados rotan en la semana `week` (un tercio cada semana), en una línea. */
export function heavyThisWeek(
  stateDir: string,
  file = join(repoRoot(), BATTERY_FILE),
  week = isoWeek(),
): string {
  try {
    const b = loadBattery(file);
    const r = heavyRotation(
      b,
      cycleOfWeek(week),
      quarantinedCases(join(stateDir, HISTORY_DIR), b.cases),
    );
    return `Casos pesados que rotan esta semana (turno ${r.turn} de 3): ${r.ids.length ? r.ids.join(', ') : 'ninguno'}.`;
  } catch {
    return 'Casos pesados de esta semana: no se pudo leer la batería.';
  }
}

/** What /evolucion says without running anything: the last week, in plain Spanish. */
export function describeLast(stateDir: string): string {
  const archive = new Archive(join(stateDir, 'evolve', 'attempts.jsonl'));
  const rows = archive.read().filter((a) => a.kind === 'verdict');
  const ideas = readHypotheses(stateDir);
  const head = !proposerFromEnv()
    ? 'Auto-mejora: sin proponedor configurado (PA_EVOLVE_PROPOSER), así que no puede generar cambios.'
    : !batteryRunnerFromEnv()
      ? 'Auto-mejora: el evaluador de la batería está apagado (PA_EVOLVE_BATTERY=off); sin él ningún cambio se aprueba.'
      : 'Auto-mejora: activa, un ciclo cada domingo de madrugada; cada cambio tiene que aprobar la batería.';
  const week = isoWeek();
  const mine = rows.filter((r) => r.week === week);
  const last = (mine.length ? mine : rows.slice(-5)).slice(-5);
  const lines = last.length
    ? last.map((r) => `- ${r.hypothesis}: ${r.verdict}. ${r.reason ?? ''}`.trim())
    : ['- Todavía no se ha probado ninguna idea.'];
  return [
    head,
    `Ideas en cola: ${ideas.length}.`,
    lastBattery(rows),
    notCounting(stateDir),
    heavyThisWeek(stateDir),
    ...lines,
    'Nada entra sin pasar por PR y auditoría. /evolucion idea <texto> añade una idea; /evolucion ahora lanza un ciclo.',
  ].join('\n');
}

export interface RunNow {
  stateDir: string;
  root?: string;
  log?: (m: string) => void;
}

/** One real cycle. Never throws to the caller: the result is always a message. */
export async function runEvolution(i: RunNow): Promise<{ text: string; report?: WeekReport }> {
  const propose = proposerFromEnv();
  if (!propose) {
    return {
      text: 'No hay proponedor configurado (PA_EVOLVE_PROPOSER): sin él no puedo generar cambios, así que no lanzo el ciclo.',
    };
  }
  const run = batteryRunnerFromEnv();
  if (!run) {
    return {
      text: 'El evaluador de la batería está apagado (PA_EVOLVE_BATTERY=off): sin él ningún cambio puede aprobarse, así que no lanzo el ciclo.',
    };
  }
  try {
    // Los casos heavy rotan por semana ISO: base y candidato corren la misma selección.
    const cycle = cycleOfWeek(isoWeek());
    const gate = gateFromFile(join(i.root ?? repoRoot(), BATTERY_FILE), run);
    const historyDir = join(i.stateDir, HISTORY_DIR);
    const battery = {
      ...gate,
      cycle,
      quarantined: quarantinedCases(historyDir, gate.cases),
      onBase: (base: BatteryRun) => recordBaseWeek(historyDir, base.results),
    };
    const report = await runWeek({
      stateDir: i.stateDir,
      root: i.root,
      battery,
      propose,
      hypotheses: async () => readHypotheses(i.stateDir),
      log: i.log,
    });
    return { text: summarize(report), report };
  } catch (err) {
    return { text: `El ciclo de auto-mejora no pudo ejecutarse: ${(err as Error).message}` };
  }
}

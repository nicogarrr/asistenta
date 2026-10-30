import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Archive, isoWeek } from './archive.js';
import { BATTERY_FILE, type BatteryRunner, gateFromFile } from './battery-gate.js';
import type { Trace } from './battery-judge.js';
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
    now.getDay() === 0 && now.getHours() >= 3 && now.getTime() - lastRunMs > 6 * 24 * 3_600_000
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
 * PA_EVOLVE_BATTERY: comando que ejecuta UN caso de la batería contra el código de su
 * carpeta (cwd) y escribe la traza como JSON. El caso llega en PA_BATTERY_CASE. Igual que
 * el proponedor, recibe el entorno limpio: nada de claves salvo PA_EVOLVE_PROPOSER_PASS.
 */
export function batteryRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): BatteryRunner | null {
  const cmd = env.PA_EVOLVE_BATTERY?.trim();
  if (!cmd) return null;
  return async (c, cwd) => {
    const { stdout } = await exec(cmd, [], {
      cwd,
      timeout: 10 * 60_000,
      windowsHide: true,
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...proposerEnv(env), PA_BATTERY_CASE: JSON.stringify(c) },
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

/** What /evolucion says without running anything: the last week, in plain Spanish. */
export function describeLast(stateDir: string): string {
  const archive = new Archive(join(stateDir, 'evolve', 'attempts.jsonl'));
  const rows = archive.read().filter((a) => a.kind === 'verdict');
  const ideas = readHypotheses(stateDir);
  const head = !proposerFromEnv()
    ? 'Auto-mejora: sin proponedor configurado (PA_EVOLVE_PROPOSER), así que no puede generar cambios.'
    : !batteryRunnerFromEnv()
      ? 'Auto-mejora: falta el evaluador de la batería (PA_EVOLVE_BATTERY); sin él ningún cambio se aprueba.'
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
      text: 'No hay evaluador de la batería (PA_EVOLVE_BATTERY): sin él ningún cambio puede aprobarse, así que no lanzo el ciclo.',
    };
  }
  try {
    // Los casos heavy rotan por semana ISO: base y candidato corren la misma selección.
    const cycle = Number(isoWeek().split('W')[1]) || 0;
    const battery = { ...gateFromFile(join(i.root ?? repoRoot(), BATTERY_FILE), run), cycle };
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

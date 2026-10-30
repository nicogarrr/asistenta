/**
 * F4 — Rutinas de comando: un programa con argv explícito, a su hora, sin pasar
 * por el modelo (coste 0). La salida se entrega tal cual (recortada) por el mismo
 * reparto de F6 (chat/fichero/ninguno, «solo si cambia»).
 *
 * Seguridad:
 * - Sin shell: argv[0] se lanza con spawn(shell: false); `;`, `|`, `$()` son texto.
 * - Solo el dueño, en su chat privado, propone y confirma (/cron comando …).
 * - La aprobación queda ligada al hash EXACTO de argv + cwd + timeout. Si alguien
 *   edita el JSON a mano, el hash ya no cuadra y no se ejecuta.
 * - Desactivado por defecto: PA_CRON_COMANDOS=1 lo activa. Con la función apagada,
 *   una rutina de comando NUNCA cae al modelo: avisa y no hace nada.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileReplacing } from './fs-tmp.js';

/** Marca en `routine.prompt`: la rutina es un comando y jamás se manda al modelo. */
export const COMMAND_PROMPT_PREFIX = '[comando] ';
export function isCommandRoutine(r: { prompt: string | null }): boolean {
  return typeof r.prompt === 'string' && r.prompt.startsWith(COMMAND_PROMPT_PREFIX);
}

export const COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
export const COMMAND_MAX_TIMEOUT_MS = 120_000;
/** Lo que se entrega como mucho (Telegram parte a 4096; queda sitio para la cabecera). */
export const COMMAND_MAX_OUTPUT = 3_500;
/** Lo que se lee de cada flujo antes de dejar de acumular. */
const CAPTURE_LIMIT = 64 * 1024;

export function commandRoutinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PA_CRON_COMANDOS === '1';
}

export interface CommandSpec {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  schedule: string;
  /** Hash de argv+cwd+timeout aprobado por el dueño; null = pendiente de confirmar. */
  approvedHash: string | null;
  createdAt: string;
}

export function commandHash(spec: Pick<CommandSpec, 'argv' | 'cwd' | 'timeoutMs'>): string {
  return createHash('sha256')
    .update(JSON.stringify([spec.argv, spec.cwd, spec.timeoutMs]))
    .digest('hex');
}

/** Código corto que el dueño teclea para aprobar exactamente ESTE comando. */
export function approvalCode(spec: Pick<CommandSpec, 'argv' | 'cwd' | 'timeoutMs'>): string {
  return commandHash(spec).slice(0, 8);
}

export function isApproved(spec: CommandSpec): boolean {
  return spec.approvedHash !== null && spec.approvedHash === commandHash(spec);
}

/** Cómo se enseña un argv: cada argumento con espacios o comillas va entre comillas. */
export function displayArgv(argv: string[]): string {
  return argv
    .map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
}

/**
 * Trocea una línea en argv como lo haría una persona, sin shell: espacios separan,
 * comillas simples o dobles agrupan; dentro de dobles solo `\"` es escape (las rutas
 * de Windows conservan sus `\`).
 * Devuelve null si una comilla queda abierta.
 */
export function splitArgv(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\' && line[i + 1] === '"') cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has) out.push(cur);
  return out;
}

export interface ParsedCommandAdd {
  schedule: string;
  argv: string[];
  timeoutMs: number;
}

/**
 * `/cron comando <horario cron> [--timeout N] -- <programa> [args…]`.
 * El `--` es obligatorio: separa el horario (que lleva espacios) del comando.
 */
export function parseCommandAdd(
  body: string,
  validate: (expr: string) => { ok: true } | { ok: false; error: string },
): { ok: true; value: ParsedCommandAdd } | { ok: false; error: string } {
  const usage =
    'Formato: /cron comando <horario cron> [--timeout segundos] -- <programa> [argumentos]\nEj.: /cron comando 0 8 * * * -- node C:\\scripts\\saldo.js';
  const sep = body.indexOf(' -- ');
  if (sep < 0) return { ok: false, error: usage };
  let head = body.slice(0, sep).trim();
  const argv = splitArgv(body.slice(sep + 4).trim());
  if (!argv) return { ok: false, error: 'Hay una comilla sin cerrar en el comando.' };
  if (argv.length === 0 || !argv[0]) return { ok: false, error: usage };
  let timeoutMs = COMMAND_DEFAULT_TIMEOUT_MS;
  const t = /(?:^|\s)--timeout\s+(\d+)\s*$/.exec(head);
  if (t) {
    const secs = Number(t[1]);
    if (!(secs >= 1 && secs * 1000 <= COMMAND_MAX_TIMEOUT_MS)) {
      return {
        ok: false,
        error: `El tiempo máximo va de 1 a ${COMMAND_MAX_TIMEOUT_MS / 1000} segundos.`,
      };
    }
    timeoutMs = secs * 1000;
    head = head.slice(0, t.index).trim();
  }
  if (!head) return { ok: false, error: usage };
  const check = validate(head);
  if (!check.ok) return { ok: false, error: `Ese horario no vale: ${check.error}` };
  return { ok: true, value: { schedule: head, argv, timeoutMs } };
}

/** Propuestas y aprobaciones, en un JSON de estado (escritura atómica). */
export class CommandRoutineStore {
  #path: string;
  constructor(path: string) {
    this.#path = path;
  }

  #read(): Record<string, CommandSpec> {
    if (!existsSync(this.#path)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as unknown;
      return raw && typeof raw === 'object' ? (raw as Record<string, CommandSpec>) : {};
    } catch {
      return {};
    }
  }

  #write(all: Record<string, CommandSpec>): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileReplacing(this.#path, `${JSON.stringify(all, null, 2)}\n`);
  }

  get(scope: string, name: string): CommandSpec | null {
    const spec = this.#read()[`${scope}\u0000${name}`];
    if (!spec || !Array.isArray(spec.argv) || typeof spec.cwd !== 'string') return null;
    return spec;
  }

  /** Guarda (o sustituye) una propuesta; siempre queda SIN aprobar. */
  propose(scope: string, name: string, spec: Omit<CommandSpec, 'approvedHash'>): CommandSpec {
    const all = this.#read();
    const saved: CommandSpec = { ...spec, approvedHash: null };
    all[`${scope}\u0000${name}`] = saved;
    this.#write(all);
    return saved;
  }

  /** Aprueba solo si el código corresponde al comando guardado ahora mismo. */
  approve(scope: string, name: string, code: string): CommandSpec | null {
    const all = this.#read();
    const k = `${scope}\u0000${name}`;
    const spec = all[k];
    if (!spec || code.trim().toLowerCase() !== approvalCode(spec)) return null;
    spec.approvedHash = commandHash(spec);
    this.#write(all);
    return spec;
  }

  remove(scope: string, name: string): void {
    const all = this.#read();
    if (delete all[`${scope}\u0000${name}`]) this.#write(all);
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** El programa no se pudo lanzar (no existe, sin permiso…). */
  spawnError?: string;
}

export type SpawnLike = typeof spawn;

/** Ejecuta argv sin shell, con tope de tiempo y de bytes leídos. */
export function runCommand(
  spec: Pick<CommandSpec, 'argv' | 'cwd' | 'timeoutMs'>,
  spawnImpl: SpawnLike = spawn,
  platform: NodeJS.Platform = process.platform,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const [file, ...args] = spec.argv;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<SpawnLike>;
    try {
      child = spawnImpl(file as string, args, {
        cwd: spec.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // En Windows no hay señales y kill() solo mata al hijo directo: un .bat o
      // un script que lanza otro programa dejaría nietos vivos. taskkill /T mata
      // el árbol entero, igual que la herramienta shell.
      if (platform === 'win32' && child.pid) {
        try {
          spawnImpl('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
        } catch {}
      } else {
        child.kill('SIGKILL');
      }
    }, spec.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < CAPTURE_LIMIT) stdout += d;
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < CAPTURE_LIMIT) stderr += d;
    });
    child.on('error', (err) =>
      done({ code: null, stdout, stderr, timedOut, spawnError: err.message }),
    );
    child.on('close', (code) => done({ code, stdout, stderr, timedOut }));
  });
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (recortado: ${text.length - max} caracteres más)`;
}

/** El texto que se entrega, y si cuenta como fallo (fallo = siempre se avisa). */
export function formatCommandResult(
  r: CommandResult,
  timeoutMs: number,
): { body: string; failed: boolean } {
  if (r.spawnError) return { body: `No se pudo lanzar el comando: ${r.spawnError}`, failed: true };
  const tailOf = (s: string) => s.trimEnd().split(/\r?\n/).slice(-10).join('\n');
  if (r.timedOut) {
    const partial = tailOf(r.stdout);
    return {
      body: clip(
        `Se cortó tras ${Math.round(timeoutMs / 1000)} s sin terminar.${partial ? `\nÚltimas líneas:\n${partial}` : ''}`,
        COMMAND_MAX_OUTPUT,
      ),
      failed: true,
    };
  }
  if (r.code !== 0) {
    const err = tailOf(r.stderr) || tailOf(r.stdout);
    return {
      body: clip(
        `Falló (código ${r.code ?? '?'}).${err ? `\nÚltimas líneas:\n${err}` : ''}`,
        COMMAND_MAX_OUTPUT,
      ),
      failed: true,
    };
  }
  const out = r.stdout.trim();
  return { body: out ? clip(out, COMMAND_MAX_OUTPUT) : '(sin salida)', failed: false };
}

/**
 * Lo que hace el disparo de una rutina de comando. Nunca llama al modelo: si la
 * función está apagada, falta la aprobación o el comando cambió, lo dice y para.
 */
export async function fireCommandRoutine(
  store: Pick<CommandRoutineStore, 'get'>,
  routine: { scope: string; name: string; schedule: string | null },
  opts: { enabled: boolean; spawnImpl?: SpawnLike },
): Promise<{ body: string; failed: boolean }> {
  if (!opts.enabled) {
    return {
      body: 'Las rutinas de comando están desactivadas (PA_CRON_COMANDOS=1 para activarlas). No se ha ejecutado nada.',
      failed: true,
    };
  }
  const spec = store.get(routine.scope, routine.name);
  if (!spec)
    return {
      body: 'No encuentro el comando de esta rutina. No se ha ejecutado nada.',
      failed: true,
    };
  if (!isApproved(spec) || (routine.schedule ?? '').trim() !== spec.schedule.trim()) {
    return {
      body: 'El comando guardado no coincide con el que aprobaste (o no está aprobado). No se ha ejecutado nada. Vuelve a crearlo con /cron comando.',
      failed: true,
    };
  }
  const result = await runCommand(spec, opts.spawnImpl);
  return formatCommandResult(result, spec.timeoutMs);
}

/**
 * Scripts del usuario en eventos del asistente (hueco #15 frente a Grok/Hermes).
 *
 * Nico deja un script suyo (.ps1, .js, .bat…) en la carpeta `scripts` del estado y
 * Asistenta lo lanza cuando pasa algo: termina una rutina, suena un recordatorio, llega
 * un aviso de GitHub, un correo, una descarga o un mensaje suyo con cierta palabra.
 *
 * El nombre del fichero dice cuándo: `<evento>.<ext>` o `<evento>-<palabras>.<ext>`.
 *   rutina.ps1                → al terminar cualquier rutina
 *   rutina-copia.ps1          → al terminar una rutina cuyo nombre lleva «copia»
 *   recordatorio-pastilla.js  → cuando suena un recordatorio que dice «pastilla»
 *   github-rojo.bat           → aviso de GitHub con «rojo» (CI de main en rojo)
 *   mensaje-buenas-noches.ps1 → un mensaje tuyo que dice «buenas noches»
 *   correo-factura.ps1, descarga-pdf.ps1
 *
 * Seguridad (todo endurece, nada afloja):
 * - Apagado salvo `PA_SCRIPTS=1`. Sin esa línea no se lanza nada.
 * - Un script solo corre si el dueño lo aprobó con `/scripts aprobar <nombre>` en su chat
 *   privado. La aprobación va ligada al hash EXACTO del contenido: si el fichero cambia
 *   (lo edita alguien, o el propio asistente), deja de correr hasta aprobarlo otra vez.
 * - Sin shell: intérprete + ruta del script, como las rutinas de comando (F4). El texto
 *   del evento viaja en variables de entorno (ASISTENTA_EVENTO, ASISTENTA_TEXTO…), nunca en la línea de
 *   órdenes, y el entorno va sin credenciales (childEnv).
 * - Tope de tiempo (PA_SCRIPTS_TIMEOUT, 30 s por defecto, máx. 300) que mata el árbol entero
 *   en Windows; un script que sigue corriendo no se lanza dos veces a la vez.
 * - Los mensajes solo cuentan si son del dueño en su chat privado.
 * - Cada ejecución queda en `log/scripts.log` (acotado: rota a 256 KB).
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { childEnv } from './child-env.js';
import { type CommandResult, runCommand } from './command-routine.js';
import { writeFileReplacing } from './fs-tmp.js';
import { foldAccents } from './text.js';

export const SCRIPT_EVENTS = [
  'rutina',
  'recordatorio',
  'github',
  'mensaje',
  'correo',
  'descarga',
] as const;
export type ScriptEvent = (typeof SCRIPT_EVENTS)[number];

const EXTENSIONS = new Set(['.ps1', '.js', '.mjs', '.cjs', '.bat', '.cmd', '.sh']);
export const SCRIPTS_DEFAULT_TIMEOUT_MS = 30_000;
export const SCRIPTS_MAX_TIMEOUT_MS = 300_000;
/** Lo que se pasa del texto del evento (las variables de entorno de Windows tienen tope). */
const TEXT_LIMIT = 2_000;
export const SCRIPTS_LOG_MAX_BYTES = 256 * 1024;

export function userScriptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PA_SCRIPTS === '1';
}

/** PA_SCRIPTS_TIMEOUT en segundos (1–300); cualquier otra cosa = 30 s. */
export function userScriptsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PA_SCRIPTS_TIMEOUT);
  if (!Number.isFinite(n) || n <= 0) return SCRIPTS_DEFAULT_TIMEOUT_MS;
  return Math.min(SCRIPTS_MAX_TIMEOUT_MS, Math.max(1_000, Math.round(n * 1000)));
}

export interface ScriptFile {
  name: string;
  event: ScriptEvent;
  /** Palabras que tiene que llevar el texto del evento (sin tildes, minúsculas); vacío = siempre. */
  words: string;
}

const fold = (s: string): string => foldAccents(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** «mensaje-buenas-noches.ps1» → { event: 'mensaje', words: 'buenas noches' }; null si no casa. */
export function parseScriptName(name: string): ScriptFile | null {
  const ext = extname(name).toLowerCase();
  if (!EXTENSIONS.has(ext)) return null;
  const stem = name.slice(0, -ext.length);
  const m = /^([a-zA-ZáéíóúÁÉÍÓÚ]+)(?:[-_ ](.+))?$/.exec(stem);
  if (!m) return null;
  const event = fold(m[1] as string) as ScriptEvent;
  if (!SCRIPT_EVENTS.includes(event)) return null;
  const words = fold((m[2] ?? '').replace(/[-_]+/g, ' '));
  return { name, event, words };
}

/** ¿El texto del evento lleva las palabras del nombre? Sin tildes ni mayúsculas. */
export function scriptMatches(file: ScriptFile, event: ScriptEvent, text: string): boolean {
  if (file.event !== event) return false;
  return file.words === '' || fold(text).includes(file.words);
}

/** Intérprete + argumentos para lanzar el script SIN shell; null si no se sabe en esta plataforma. */
export function scriptArgv(
  path: string,
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath,
): string[] | null {
  const ext = extname(path).toLowerCase();
  const win = platform === 'win32';
  if (ext === '.ps1')
    return [
      win ? 'powershell.exe' : 'pwsh',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path,
    ];
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return [nodePath, path];
  if (ext === '.bat' || ext === '.cmd') return win ? ['cmd.exe', '/d', '/c', path] : null;
  if (ext === '.sh') return win ? null : ['sh', path];
  return null;
}

export type ScriptState = 'aprobado' | 'pendiente' | 'cambiado';

export interface ScriptInfo extends ScriptFile {
  state: ScriptState;
  hash: string;
}

export interface UserScriptsDeps {
  dir: string;
  logFile: string;
  enabled?: () => boolean;
  timeoutMs?: () => number;
  /** Aviso al dueño (script nuevo sin aprobar, script que falla). Opcional. */
  notify?: (text: string) => Promise<unknown> | unknown;
  run?: (spec: {
    argv: string[];
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
  }) => Promise<CommandResult>;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export interface FireResult {
  name: string;
  outcome: 'ok' | 'fallo' | 'sin-aprobar' | 'ocupado' | 'no-soportado';
  detail: string;
}

const hashOf = (text: Buffer): string => createHash('sha256').update(text).digest('hex');

export class UserScripts {
  readonly #deps: UserScriptsDeps;
  readonly #running = new Set<string>();
  readonly #approvalsFile: string;
  readonly #noticesFile: string;

  constructor(deps: UserScriptsDeps) {
    this.#deps = deps;
    this.#approvalsFile = join(deps.dir, '.aprobados.json');
    this.#noticesFile = join(deps.dir, '.avisados.json');
  }

  get dir(): string {
    return this.#deps.dir;
  }

  enabled(): boolean {
    return this.#deps.enabled ? this.#deps.enabled() : userScriptsEnabled();
  }

  #readJson(path: string): Record<string, string> {
    try {
      const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  #writeJson(path: string, value: Record<string, string>): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileReplacing(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Crea la carpeta con un LEEME la primera vez (solo con la función encendida). */
  ensureDir(): void {
    mkdirSync(this.#deps.dir, { recursive: true });
    const readme = join(this.#deps.dir, 'LEEME.txt');
    if (!existsSync(readme)) writeFileSync(readme, SCRIPTS_README);
  }

  /** Los scripts de la carpeta con su estado de aprobación. */
  list(): ScriptInfo[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.#deps.dir);
    } catch {
      return [];
    }
    const approved = this.#readJson(this.#approvalsFile);
    const out: ScriptInfo[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      const file = parseScriptName(name);
      if (!file) continue;
      let hash: string;
      try {
        const path = join(this.#deps.dir, name);
        if (!statSync(path).isFile()) continue;
        hash = hashOf(readFileSync(path));
      } catch {
        continue;
      }
      const ok = approved[name];
      out.push({ ...file, hash, state: !ok ? 'pendiente' : ok === hash ? 'aprobado' : 'cambiado' });
    }
    return out;
  }

  /** ¿Hay algún script aprobado para este evento? (para no encender fuentes de más) */
  wants(event: ScriptEvent): boolean {
    return this.enabled() && this.list().some((s) => s.event === event && s.state === 'aprobado');
  }

  /** Busca un script por nombre, sin tildes ni mayúsculas, con o sin extensión. */
  find(name: string): ScriptInfo | undefined {
    const want = fold(name);
    const all = this.list();
    return (
      all.find((s) => fold(s.name) === want) ??
      all.find((s) => fold(s.name.slice(0, -extname(s.name).length)) === want)
    );
  }

  approve(name: string): ScriptInfo | undefined {
    const s = this.find(name);
    if (!s) return undefined;
    const approved = this.#readJson(this.#approvalsFile);
    approved[s.name] = s.hash;
    this.#writeJson(this.#approvalsFile, approved);
    return { ...s, state: 'aprobado' };
  }

  revoke(name: string): ScriptInfo | undefined {
    const s = this.find(name);
    if (!s) return undefined;
    const approved = this.#readJson(this.#approvalsFile);
    delete approved[s.name];
    this.#writeJson(this.#approvalsFile, approved);
    return { ...s, state: 'pendiente' };
  }

  #log(line: string): void {
    const file = this.#deps.logFile;
    try {
      mkdirSync(dirname(file), { recursive: true });
      try {
        if (statSync(file).size > SCRIPTS_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
      } catch {}
      const at = new Date(this.#deps.now?.() ?? Date.now())
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      appendFileSync(file, `${at} ${line.replace(/\r?\n/g, ' ⏎ ')}\n`);
    } catch {}
  }

  /** Últimas líneas del registro (para /scripts log). */
  tail(lines = 15): string[] {
    try {
      return readFileSync(this.#deps.logFile, 'utf8').trimEnd().split('\n').slice(-lines);
    } catch {
      return [];
    }
  }

  /** Avisa una vez por versión de un script que espera aprobación. */
  #noticePending(s: ScriptInfo): void {
    if (!this.#deps.notify) return;
    const seen = this.#readJson(this.#noticesFile);
    if (seen[s.name] === s.hash) return;
    seen[s.name] = s.hash;
    try {
      this.#writeJson(this.#noticesFile, seen);
    } catch {}
    const why = s.state === 'cambiado' ? 'ha cambiado desde que lo aprobaste' : 'es nuevo';
    void Promise.resolve(
      this.#deps.notify(
        `📜 El script «${s.name}» ${why} y no lo he ejecutado. Si es tuyo y está bien: /scripts aprobar ${s.name}`,
      ),
    ).catch(() => {});
  }

  /**
   * Un evento del asistente: lanza los scripts aprobados que casan. Nunca lanza
   * excepción ni bloquea al que llama más allá de esperar a los scripts.
   */
  async fire(
    event: ScriptEvent,
    text: string,
    extra: Record<string, string> = {},
  ): Promise<FireResult[]> {
    if (!this.enabled()) return [];
    const matching = this.list().filter((s) => scriptMatches(s, event, text));
    return Promise.all(matching.map((s) => this.#runOne(s, event, text, extra)));
  }

  /** «/scripts probar <nombre>»: lo lanza ya con el evento «prueba». */
  async test(name: string): Promise<FireResult | undefined> {
    const s = this.find(name);
    if (!s) return undefined;
    return this.#runOne(s, s.event, s.words || 'prueba', { ASISTENTA_PRUEBA: '1' });
  }

  async #runOne(
    s: ScriptInfo,
    event: ScriptEvent,
    text: string,
    extra: Record<string, string>,
  ): Promise<FireResult> {
    if (s.state !== 'aprobado') {
      this.#log(`${s.name} [${event}] sin aprobar (${s.state}): no se ejecuta`);
      this.#noticePending(s);
      return { name: s.name, outcome: 'sin-aprobar', detail: s.state };
    }
    const path = join(this.#deps.dir, s.name);
    const argv = scriptArgv(path, this.#deps.platform);
    if (!argv) {
      this.#log(`${s.name} [${event}] no se puede lanzar en este sistema`);
      return { name: s.name, outcome: 'no-soportado', detail: extname(s.name) };
    }
    if (this.#running.has(s.name)) {
      this.#log(`${s.name} [${event}] sigue corriendo la vez anterior: esta se salta`);
      return { name: s.name, outcome: 'ocupado', detail: '' };
    }
    this.#running.add(s.name);
    const timeoutMs = this.#deps.timeoutMs?.() ?? userScriptsTimeoutMs();
    const env = childEnv({
      ...extra,
      ASISTENTA_EVENTO: event,
      ASISTENTA_TEXTO: text.slice(0, TEXT_LIMIT),
      ASISTENTA_SCRIPT: s.name,
    });
    const started = this.#deps.now?.() ?? Date.now();
    try {
      const run = this.#deps.run ?? runCommand;
      const r = await run({ argv, cwd: this.#deps.dir, timeoutMs, env });
      const secs = (((this.#deps.now?.() ?? Date.now()) - started) / 1000).toFixed(1);
      const lastLine = (s_: string) => s_.trimEnd().split(/\r?\n/).pop()?.slice(0, 200) ?? '';
      let outcome: FireResult['outcome'] = 'ok';
      let detail = lastLine(r.stdout);
      if (r.spawnError) {
        outcome = 'fallo';
        detail = `no se pudo lanzar: ${r.spawnError}`;
      } else if (r.timedOut) {
        outcome = 'fallo';
        detail = `cortado a los ${Math.round(timeoutMs / 1000)} s`;
      } else if (r.code !== 0) {
        outcome = 'fallo';
        detail = `código ${r.code ?? '?'}${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ''}`;
      }
      this.#log(`${s.name} [${event}] ${outcome} ${secs} s${detail ? ` · ${detail}` : ''}`);
      return { name: s.name, outcome, detail };
    } catch (err) {
      this.#log(`${s.name} [${event}] fallo · ${String(err).slice(0, 200)}`);
      return { name: s.name, outcome: 'fallo', detail: String(err) };
    } finally {
      this.#running.delete(s.name);
    }
  }
}

const STATE_ICON: Record<ScriptState, string> = {
  aprobado: '✅',
  pendiente: '⏳ sin aprobar',
  cambiado: '✏️ cambiado, sin aprobar',
};

const EVENT_TEXT: Record<ScriptEvent, string> = {
  rutina: 'al terminar una rutina',
  recordatorio: 'cuando suena un recordatorio',
  github: 'con un aviso de GitHub',
  mensaje: 'con un mensaje tuyo',
  correo: 'con un correo nuevo',
  descarga: 'con una descarga nueva',
};

/** Texto de /scripts. */
export function formatScriptsStatus(scripts: UserScripts, lastLines: string[] = []): string {
  if (!scripts.enabled()) {
    return [
      '📜 Scripts en eventos: apagados.',
      'Para usarlos pon PA_SCRIPTS=1 en el .env y reinicia. Luego deja tus scripts (.ps1, .js, .bat) en:',
      scripts.dir,
      'El nombre dice cuándo se lanzan: rutina.ps1, recordatorio-pastilla.ps1, github-rojo.bat, mensaje-buenas-noches.ps1…',
    ].join('\n');
  }
  const list = scripts.list();
  const lines = ['📜 Scripts en eventos (carpeta):', scripts.dir, ''];
  if (list.length === 0) {
    lines.push(
      'No hay ninguno todavía. Ejemplos de nombre: rutina.ps1, recordatorio-pastilla.ps1, github-rojo.bat, mensaje-buenas-noches.ps1, correo-factura.js, descarga-pdf.ps1.',
    );
  }
  for (const s of list) {
    const when = `${EVENT_TEXT[s.event]}${s.words ? ` que diga «${s.words}»` : ''}`;
    lines.push(`• ${s.name} — ${when} · ${STATE_ICON[s.state]}`);
  }
  if (list.some((s) => s.state !== 'aprobado'))
    lines.push('', 'Para que uno se ejecute: /scripts aprobar <nombre> (o «todos»).');
  if (lastLines.length) lines.push('', 'Últimas ejecuciones:', ...lastLines.slice(-5));
  lines.push('', '/scripts probar <nombre> · /scripts quitar <nombre> · /scripts log');
  return lines.join('\n');
}

/**
 * /scripts [aprobar|quitar|probar|log] [nombre]. Solo el dueño en su chat privado
 * (lo comprueba quien llama). Devuelve el texto de respuesta.
 */
export async function scriptsCommand(scripts: UserScripts, args: string): Promise<string> {
  const [verbRaw = '', ...rest] = args.trim().split(/\s+/);
  const verb = fold(verbRaw);
  const name = rest.join(' ').trim();
  if (verb === '' || verb === 'lista' || verb === 'list') {
    return formatScriptsStatus(scripts, scripts.tail(5));
  }
  if (verb === 'log' || verb === 'registro') {
    const t = scripts.tail(15);
    return t.length
      ? `📜 Últimas ejecuciones:\n${t.join('\n')}`
      : 'Todavía no se ha ejecutado ningún script.';
  }
  if (!['aprobar', 'aprueba', 'quitar', 'quita', 'probar', 'prueba'].includes(verb)) {
    return 'Uso: /scripts · /scripts aprobar <nombre|todos> · /scripts quitar <nombre> · /scripts probar <nombre> · /scripts log';
  }
  if (!name) return `Dime cuál: /scripts ${verb} <nombre>`;
  if (verb.startsWith('aprob')) {
    if (fold(name) === 'todos') {
      const pend = scripts.list().filter((s) => s.state !== 'aprobado');
      for (const s of pend) scripts.approve(s.name);
      return pend.length
        ? `✅ Aprobados: ${pend.map((s) => s.name).join(', ')}.`
        : 'No hay ninguno pendiente de aprobar.';
    }
    const s = scripts.approve(name);
    if (!s) return `No encuentro «${name}» en ${scripts.dir}.`;
    const off = scripts.enabled() ? '' : ' (ojo: la función está apagada; PA_SCRIPTS=1 en el .env)';
    return `✅ «${s.name}» aprobado: se lanzará ${EVENT_TEXT[s.event]}${s.words ? ` que diga «${s.words}»` : ''}. Si cambias el fichero, hay que aprobarlo otra vez.${off}`;
  }
  if (verb.startsWith('quit')) {
    const s = scripts.revoke(name);
    return s
      ? `Hecho: «${s.name}» ya no se ejecutará (el fichero sigue en la carpeta).`
      : `No encuentro «${name}».`;
  }
  if (!scripts.enabled())
    return 'Los scripts están apagados: pon PA_SCRIPTS=1 en el .env y reinicia.';
  const r = await scripts.test(name);
  if (!r) return `No encuentro «${name}» en ${scripts.dir}.`;
  if (r.outcome === 'sin-aprobar')
    return `«${r.name}» no está aprobado: /scripts aprobar ${r.name}`;
  if (r.outcome === 'ocupado') return `«${r.name}» todavía está corriendo.`;
  if (r.outcome === 'no-soportado') return `«${r.name}»: no sé lanzar ${r.detail} en este sistema.`;
  return `${r.outcome === 'ok' ? '✅' : '⚠️'} «${r.name}»: ${r.outcome === 'ok' ? 'terminó bien' : 'falló'}${r.detail ? ` — ${r.detail}` : ''}.`;
}

export const SCRIPTS_README = `Scripts de Asistenta en eventos
================================

Deja aquí scripts tuyos y Asistenta los lanza cuando pasa algo.
Solo funciona con PA_SCRIPTS=1 en el .env, y cada script hay que aprobarlo
una vez desde Telegram con /scripts aprobar <nombre>. Si cambias el
fichero, hay que aprobarlo otra vez.

El nombre del fichero dice cuándo se lanza:
  rutina.ps1                 al terminar cualquier rutina
  rutina-copia.ps1           al terminar una rutina cuyo nombre lleva «copia»
  recordatorio.ps1           cuando suena cualquier recordatorio
  recordatorio-pastilla.js   cuando suena un recordatorio que dice «pastilla»
  github-rojo.bat            cuando el CI de GitHub se pone en rojo
  mensaje-buenas-noches.ps1  cuando le escribes «buenas noches»
  correo-factura.ps1         con un correo nuevo que dice «factura» (remitente o asunto)
  descarga-pdf.ps1           con una descarga nueva que lleva «pdf» en el nombre

Tipos: .ps1 (PowerShell), .js/.mjs (Node), .bat/.cmd.

Lo que recibe el script (variables de entorno):
  ASISTENTA_EVENTO  rutina | recordatorio | github | mensaje | correo | descarga
  ASISTENTA_TEXTO   el texto del evento (nombre de la rutina, el recordatorio, el aviso…)
  ASISTENTA_OK      en rutinas: 1 si fue bien, 0 si falló
  ASISTENTA_SALIDA  en rutinas: el principio de lo que respondió
  ASISTENTA_PRUEBA  1 cuando lo lanzas con /scripts probar

Tiene 30 segundos (PA_SCRIPTS_TIMEOUT para cambiarlo, máx. 300). Cada ejecución
queda apuntada en log/scripts.log. Ojo: ASISTENTA_TEXTO de GitHub, correos y descargas
lo escriben otros; trátalo como texto, nunca lo ejecutes.
`;

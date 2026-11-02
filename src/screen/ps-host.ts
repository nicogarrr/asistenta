import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { log } from '../log.js';

/**
 * Un único PowerShell vivo para las acciones de pantalla.
 *
 * Antes cada captura, clic o movimiento lanzaba un `powershell.exe` nuevo y COMPILABA el
 * C# de `Add-Type` otra vez (cientos de ms por paso). Aquí se arranca una vez, los tipos
 * se compilan una vez (Add-Type es idempotente dentro del host) y cada script llega por
 * stdin en base64, una línea por petición, con marcador de fin.
 *
 * Seguridad de la repetición: solo se vuelve al camino de siempre cuando el host NO llegó
 * a recibir el script. Si se cortó con el script ya enviado, se devuelve el error (un clic
 * repetido a ciegas sería peor que un fallo).
 */

/** Error del propio script (igual que si hubiera corrido en su propio proceso). */
export class PsScriptError extends Error {
  readonly errorText: string;
  constructor(errorText: string) {
    super(errorText);
    this.errorText = errorText;
  }
}

/** El host no está disponible y el script NO se envió: se puede usar el camino de siempre. */
export class PsHostUnavailable extends Error {}

/** El host murió o no contestó con el script ya enviado: no se repite. */
export class PsHostLost extends Error {
  readonly cut: boolean;
  constructor(message: string, cut: boolean) {
    super(message);
    this.cut = cut;
  }
}

/** Script de arranque del host: bucle que lee `id base64` y contesta `PA_DONE id código`. */
export const HOST_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$global:paTypes = @{}
function global:Add-Type {
  param([Parameter(Position = 0)][string]$TypeDefinition, [string[]]$AssemblyName)
  if ($AssemblyName) { Microsoft.PowerShell.Utility\Add-Type -AssemblyName $AssemblyName; return }
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $h = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($TypeDefinition)))
  if ($global:paTypes.ContainsKey($h)) { return }
  Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $TypeDefinition
  $global:paTypes[$h] = $true
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $i = $line.IndexOf(' ')
  $id = $line.Substring(0, $i)
  $code = 0
  try {
    $src = $utf8.GetString([Convert]::FromBase64String($line.Substring($i + 1)))
    $out = (& ([scriptblock]::Create($src)) 2>&1 | Out-String)
    [Console]::Out.Write($out)
  } catch {
    $code = 1
    $msg = [Convert]::ToBase64String($utf8.GetBytes(($_ | Out-String)))
    [Console]::Out.WriteLine('')
    [Console]::Out.WriteLine("PA_ERR $id $msg")
  }
  [Console]::Out.WriteLine('')
  [Console]::Out.WriteLine("PA_DONE $id $code")
  [Console]::Out.Flush()
}
`;

export type HostSpawn = () => ChildProcessWithoutNullStreams;

export interface PsHostOptions {
  spawnHost?: HostSpawn;
  timeoutMs?: number;
  startTimeoutMs?: number;
}

interface Pending {
  id: string;
  out: string;
  errB64: string | null;
  resolve: (r: { stdout: string; stderr: string }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function defaultSpawn(env: NodeJS.ProcessEnv): HostSpawn {
  return () =>
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(HOST_BOOTSTRAP, 'utf16le').toString('base64'),
      ],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
}

export class PsHost {
  readonly #spawnHost: HostSpawn;
  readonly #timeoutMs: number;
  readonly #startTimeoutMs: number;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #buffer = '';
  #pending: Pending | null = null;
  #seq = 0;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(env: NodeJS.ProcessEnv, opts: PsHostOptions = {}) {
    this.#spawnHost = opts.spawnHost ?? defaultSpawn(env);
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#startTimeoutMs = opts.startTimeoutMs ?? 20_000;
  }

  get alive(): boolean {
    return this.#proc !== null;
  }

  /** Ejecuta un script en el host. Las llamadas se encolan: una a una. */
  run(script: string): Promise<{ stdout: string; stderr: string }> {
    const next = this.#chain.then(
      () => this.#runOne(script),
      () => this.#runOne(script),
    );
    this.#chain = next.catch(() => undefined);
    return next;
  }

  close(): void {
    const proc = this.#proc;
    this.#proc = null;
    this.#fail(new PsHostLost('PowerShell persistente cerrado.', false));
    try {
      proc?.stdin.end();
      proc?.kill();
    } catch {
      // ya muerto
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#proc) return;
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this.#spawnHost();
    } catch (err) {
      throw new PsHostUnavailable(`no arranca: ${String(err)}`);
    }
    this.#proc = proc;
    this.#buffer = '';
    // Que el host nunca impida que Asistenta termine.
    for (const h of [proc, proc.stdin, proc.stdout, proc.stderr] as unknown as {
      unref?: () => void;
    }[])
      h.unref?.();
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.#onData(chunk));
    proc.stderr.on('data', () => undefined);
    const gone = (why: string): void => {
      if (this.#proc === proc) this.#proc = null;
      this.#fail(new PsHostLost(`PowerShell persistente: ${why}`, false));
    };
    proc.on('error', (err) => gone(String(err)));
    proc.on('exit', (code) => gone(`salió con código ${String(code)}`));
    try {
      const ready = await this.#send('Write-Output PA_HOST_READY', this.#startTimeoutMs);
      if (!ready.stdout.includes('PA_HOST_READY')) throw new Error('respuesta inesperada');
    } catch (err) {
      this.close();
      throw new PsHostUnavailable(`no responde al arrancar: ${String(err)}`);
    }
  }

  async #runOne(script: string): Promise<{ stdout: string; stderr: string }> {
    await this.#ensureStarted();
    return this.#send(script, this.#timeoutMs);
  }

  #send(script: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const proc = this.#proc;
    if (!proc) return Promise.reject(new PsHostUnavailable('sin proceso'));
    this.#seq += 1;
    const id = String(this.#seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.id !== id) return;
        this.#pending = null;
        this.close();
        reject(new PsHostLost('PowerShell no respondió y se cortó.', true));
      }, timeoutMs);
      this.#pending = { id, out: '', errB64: null, resolve, reject, timer };
      try {
        proc.stdin.write(`${id} ${Buffer.from(script, 'utf8').toString('base64')}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.#pending = null;
        reject(new PsHostLost(`no se pudo escribir: ${String(err)}`, false));
      }
    });
  }

  #fail(err: Error): void {
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const nl = this.#buffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.#buffer.slice(0, nl).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(nl + 1);
      const p = this.#pending;
      if (!p) continue;
      const err = /^PA_ERR (\S+) (\S+)$/.exec(line);
      if (err && err[1] === p.id) {
        p.errB64 = err[2] ?? null;
        continue;
      }
      const done = /^PA_DONE (\S+) (\d+)$/.exec(line);
      if (done && done[1] === p.id) {
        this.#pending = null;
        clearTimeout(p.timer);
        if (done[2] !== '0') {
          const text = p.errB64 ? Buffer.from(p.errB64, 'base64').toString('utf8') : '';
          p.reject(new PsScriptError(text));
        } else {
          p.resolve({ stdout: p.out.replace(/\n+$/, '\n').replace(/^\n+$/, ''), stderr: '' });
        }
        continue;
      }
      p.out += `${line}\n`;
    }
  }
}

// ---- Latencia por acción: antes (un proceso por llamada) y después (host persistente) ----

type Mode = 'host' | 'spawn';
const samples: Record<Mode, number[]> = { host: [], spawn: [] };
const SUMMARY_EVERY = 25;
let sinceSummary = 0;

function stat(values: number[]): { n: number; avgMs: number; p50Ms: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    avgMs: Math.round(sum / values.length),
    p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
  };
}

/** Resumen de latencias por modo, para el log y para pruebas. */
export function psLatencySummary(): {
  host: ReturnType<typeof stat>;
  spawn: ReturnType<typeof stat>;
} {
  return { host: stat(samples.host), spawn: stat(samples.spawn) };
}

export function resetPsLatency(): void {
  samples.host = [];
  samples.spawn = [];
  sinceSummary = 0;
}

/** Anota una llamada; cada 25 escribe en el log el promedio y la mediana de cada modo. */
export function recordPsLatency(mode: Mode, ms: number): void {
  const list = samples[mode];
  list.push(ms);
  if (list.length > 200) list.shift();
  sinceSummary += 1;
  log.debug('powershell call', { mode, ms: Math.round(ms) });
  if (sinceSummary >= SUMMARY_EVERY) {
    sinceSummary = 0;
    log.info('powershell latency', psLatencySummary());
  }
}

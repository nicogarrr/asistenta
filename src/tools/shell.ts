import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Config } from '../config.js';
import { log } from '../log.js';
import { buildSandboxSpawn, sandboxMode, sandboxSpawnError } from './shell-sandbox.js';

/**
 * Shell execution.
 *
 * pwsh is preferred and located by absolute path. PowerShell 5.1 ships with Windows
 * and is a second-class target: no `&&`, no `??`, no ternary. A model writes
 * PowerShell 7 syntax by default, so picking 5.1 would produce failures that look
 * like agent bugs but are shell-version bugs.
 */
/**
 * How much of each end of a stream is kept.
 *
 * The old behaviour kept the first 64KB and dropped everything after it, which is
 * the wrong end for almost every real command: `Get-ChildItem` floods with the first
 * ten directories, a build logs thousands of lines of progress before the actual
 * error, and a package install ends with the part that matters. Both ends carry
 * information, so both ends are kept and the middle is summarised.
 */
const HEAD_TAIL_BYTES = 6 * 1024;

/**
 * Join a kept head and a kept tail with an explicit marker for what was dropped.
 *
 * `omitted` is passed in rather than recomputed because the collector already knows
 * it exactly, including the case where a single oversized chunk was trimmed. The
 * line count is derived from the text actually retained, which is the number the
 * model can reason about ("~400 lines came out of here").
 */
/** Por debajo de esto un comando de PowerShell ni siquiera arranca. */
const MIN_TIMEOUT_MS = 1_000;

export function headTail(head: string, tail: string, omitted: number): string {
  if (omitted <= 0) return head + tail;
  const headLines = head.split('\n').length;
  const marker =
    `\n... [${omitted} bytes (~${headLines} lines) omitted from the middle. ` +
    'Re-run with a filter, or redirect to a file and read it with the read tool.] ...\n';
  // Trim to line boundaries so neither end is half a line: a truncated JSON object
  // or a half-written log line reads as corruption rather than as truncation.
  const headBreak = head.lastIndexOf('\n');
  const headClean = headBreak >= 0 ? head.slice(0, headBreak) : head;
  const tailStart = tail.indexOf('\n');
  const tailClean = tailStart >= 0 ? tail.slice(tailStart + 1) : tail;
  return `${headClean}${marker}${tailClean}`;
}

/**
 * Bounded head-and-tail capture of one output stream.
 *
 * It exists because both obvious alternatives fail on real commands. Buffering
 * everything and trimming at the end means a command that prints 2GB tries to
 * allocate 2GB first. Keeping only the head loses the tail, and the tail is where
 * build errors, package failures and the actual answer live: a 200-line install log
 * ends with `ERR! failed`, and dropping it leaves the agent reading a progress bar
 * and concluding the command succeeded.
 *
 * Memory is bounded at 2 x `window` no matter what the command emits.
 */
export class OutputCollector {
  readonly #head: Buffer[] = [];
  readonly #tail: Buffer[] = [];
  readonly #window: number;
  #headBytes = 0;
  #tailBytes = 0;
  #total = 0;

  constructor(window = HEAD_TAIL_BYTES) {
    this.#window = window;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#total += chunk.length;

    let rest = chunk;
    if (this.#headBytes < this.#window) {
      const room = this.#window - this.#headBytes;
      const slice = rest.length <= room ? rest : rest.subarray(0, room);
      this.#head.push(slice);
      this.#headBytes += slice.length;
      rest = rest.subarray(slice.length);
    }
    if (rest.length === 0) return;

    this.#tail.push(rest);
    this.#tailBytes += rest.length;
    while (this.#tailBytes > this.#window && this.#tail.length > 1) {
      this.#tailBytes -= (this.#tail.shift() as Buffer).length;
    }
    if (this.#tailBytes > this.#window) {
      // A single chunk larger than the window: keep only its own last `window`.
      // The byte counter has to move with it, otherwise `omitted` under-reports and
      // the model is told nothing was dropped when most of the stream was.
      const last = this.#tail[this.#tail.length - 1] as Buffer;
      this.#tail[this.#tail.length - 1] = last.subarray(last.length - this.#window);
      this.#tailBytes = this.#window;
    }
  }

  get bytes(): number {
    return this.#total;
  }

  get omitted(): number {
    return Math.max(0, this.#total - this.#headBytes - this.#tailBytes);
  }

  text(): string {
    // Sin hueco, cabeza y cola son bytes contiguos: decodificarlas por separado partía
    // una «ñ» o una «á» que cayera justo en el corte en dos caracteres basura.
    if (this.omitted === 0) return Buffer.concat([...this.#head, ...this.#tail]).toString('utf8');
    // Con hueco, ni la cabeza termina ni la cola empieza a mitad de carácter.
    const head = new TextDecoder().decode(Buffer.concat(this.#head), { stream: true });
    let tail = Buffer.concat(this.#tail);
    let skip = 0;
    while (skip < tail.length && skip < 3 && ((tail[skip] as number) & 0xc0) === 0x80) skip++;
    tail = tail.subarray(skip);
    return headTail(head, tail.toString('utf8'), this.omitted);
  }
}
export function resolveShell(): { file: string } {
  const localApp = process.env.LOCALAPPDATA ?? '';
  const userProfile = process.env.USERPROFILE ?? '';
  const candidates = [
    normalize(join(userProfile, '.local', 'pwsh', 'pwsh.exe')),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
    localApp ? normalize(join(localApp, 'Microsoft', 'WindowsApps', 'pwsh.exe')) : '',
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return { file: c };
  }
  return { file: 'powershell.exe' };
}

const ShellParams = Type.Object({
  command: Type.String({ description: 'PowerShell command to run.' }),
  timeoutMs: Type.Optional(
    Type.Number({ description: 'Override the default timeout, in milliseconds.' }),
  ),
});

export function createShellTool(
  config: Config,
  deps: { spawn?: typeof spawn; env?: NodeJS.ProcessEnv } = {},
): AgentTool<typeof ShellParams> {
  const spawnImpl = deps.spawn ?? spawn;
  return {
    name: 'shell',
    label: 'Shell',
    description:
      'Run a PowerShell command and return stdout, stderr and the exit code. Long output keeps only the first and last 6KB of each stream, with a note of how much was omitted.',
    parameters: ShellParams,
    executionMode: 'sequential',
    execute: async (toolCallId, args, signal) => {
      // F12: sandbox opcional. Un modo inválido o docker ausente RECHAZA; nunca
      // cae al PC en silencio.
      const sandbox = sandboxMode(deps.env ?? process.env);
      if (!sandbox.ok) {
        return {
          content: [{ type: 'text', text: sandbox.error }],
          details: { exitCode: -1, wallMs: 0, timedOut: false, shell: 'none' },
        };
      }
      const shell = sandbox.mode === 'off' ? resolveShell() : { file: 'docker' };
      // Capped by the run's idle watchdog minus a margin: a tool that outlives the
      // watchdog would be aborted mid-flight with no result, so the watchdog must
      // always be the outer bound, never the tool.
      const ceiling = Math.max(30_000, config.idleTimeoutMs - 60_000);
      // 0, negativo o NaN no son «sin límite»: setTimeout los dispara al instante y el
      // comando moría antes de empezar. Se usa el de por defecto, y nunca menos de 1 s.
      const asked =
        typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
          ? args.timeoutMs
          : config.toolTimeoutMs;
      const timeoutMs = Math.min(Math.max(MIN_TIMEOUT_MS, asked), ceiling);
      const started = Date.now();

      const result = await new Promise<{
        code: number;
        out: string;
        err: string;
        timedOut: boolean;
        aborted: boolean;
      }>((done) => {
        const target = buildSandboxSpawn({
          mode: sandbox.mode,
          shellFile: shell.file,
          command: args.command,
          workspace: process.cwd(),
          image: (deps.env ?? process.env).PA_SHELL_SANDBOX_IMAGE?.trim() || undefined,
        });
        const child = spawnImpl(target.file, target.args, {
          cwd: process.cwd(),
          windowsHide: true,
          env: { ...process.env, NO_COLOR: '1' },
        });

        const stdout = new OutputCollector();
        const stderr = new OutputCollector();
        let timedOut = false;
        let aborted = false;

        child.stdout.on('data', (c: Buffer) => stdout.push(c));
        child.stderr.on('data', (c: Buffer) => stderr.push(c));

        // Windows has no signals, so the whole process tree dies via taskkill /T.
        // Fuera de Windows no hay taskkill: un spawn de un binario ausente emite 'error'
        // y, sin oyente, tumba el proceso entero.
        const kill = (): void => {
          if (process.platform === 'win32') {
            try {
              spawnImpl('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], {
                windowsHide: true,
              }).on('error', () => {});
            } catch {}
          } else {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
          // El contenedor no es hijo del CLI de docker: hay que matarlo por nombre.
          if (target.container) {
            try {
              spawnImpl('docker', ['kill', target.container], { windowsHide: true }).on(
                'error',
                () => {},
              );
            } catch {}
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutMs);
        // Un /stop no es un timeout: decir «timed out» hacía creer al modelo que el
        // comando era lento y lo reintentaba con más tiempo.
        const onAbort = (): void => {
          if (!timedOut) aborted = true;
          kill();
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (value: {
          code: number;
          out: string;
          err: string;
          timedOut: boolean;
          aborted: boolean;
        }): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          done(value);
        };

        child.on('close', (code) => {
          finish({
            code: code ?? -1,
            // The collector already trimmed to head+tail, so nothing else here has
            // to decide what to keep.
            out: stdout.text(),
            err: stderr.text(),
            timedOut,
            aborted,
          });
        });
        child.on('error', (e: Error) =>
          finish({
            code: -1,
            out: '',
            err: sandboxSpawnError(sandbox.mode, e.message),
            timedOut: false,
            aborted: false,
          }),
        );
      });

      const wall = Date.now() - started;
      log.info('shell', { id: toolCallId, exit: result.code, ms: wall, timedOut: result.timedOut });

      const parts: string[] = [];
      if (result.out.trim()) parts.push(result.out.trimEnd());
      if (result.err.trim()) parts.push(`[stderr]\n${result.err.trimEnd()}`);
      if (result.timedOut) parts.push(`[timed out after ${timeoutMs}ms]`);
      if (result.aborted) parts.push('[cancelled before finishing; not a timeout]');
      parts.push(`[exit ${result.code} in ${wall}ms]`);

      return {
        // Fenced as tool output: a page or script that prints "ignore previous
        // instructions" is data from the machine, not an instruction to follow.
        content: [{ type: 'text', text: `<shell_output>\n${parts.join('\n')}\n</shell_output>` }],
        details: {
          exitCode: result.code,
          wallMs: wall,
          timedOut: result.timedOut,
          aborted: result.aborted,
          shell: shell.file,
        },
      };
    },
  };
}

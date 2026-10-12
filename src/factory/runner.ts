/**
 * Sandboxed execution of factory-built tools, used BOTH for the mandatory
 * pre-install test and for every post-install call. The authored module never
 * runs in the daemon process, and inside the child it runs as a guest with no
 * capabilities: a node:vm SourceTextModule whose context has no process, no
 * require, no fetch, no imports of any kind - the linker denies everything.
 * On top of the vm boundary the child runs under --permission (fs limited to
 * the tool dir, no child_process, no workers) and with an empty environment
 * (no HOME, no PATH, nothing from the daemon).
 *
 * The verdict protocol is outside the module's control: only the supervisor
 * (our trusted code in the child) writes it, on fd 3. Guest console output is
 * captured and prefixed as '[tool]', so a module cannot forge a passing test:
 * it never touches the verdict channel.
 *
 * Resource bounds: a wall-clock timeout kills the whole process group (not
 * just the direct child), and captured output is capped - a flood kills the
 * run instead of eating daemon memory.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { factoryDir } from './store.js';
import type { FactoryToolContract } from './types.js';

export type { FactoryToolContract } from './types.js';

export type FactoryRunStage = 'import' | 'shape' | 'run' | 'timeout' | 'output' | 'supervisor';

export interface FactoryTestResult {
  ok: boolean;
  stage: FactoryRunStage;
  output: string;
  durationMs: number;
  /** Contract read from the executed module (only on ok). Persisted in TOOL.md; the loader uses it so it never imports the module in the daemon. */
  contract?: FactoryToolContract;
}

/** Cap on captured child output. */
export const MAX_FACTORY_OUTPUT_BYTES = 1024 * 1024;
const LOG_TAIL_BYTES = 4000;

/**
 * Trusted supervisor: the only code that writes the verdict (fd 3). The guest
 * module is evaluated inside a vm context that grants only pure-compute
 * globals (encoding, URL, structuredClone, timers, webcrypto). Any import -
 * static or dynamic - is rejected by the linker, so node:fs/net/child_process
 * are unreachable from guest code even before --permission applies.
 */
const SUPERVISOR_SOURCE = `
import fs from 'node:fs';
import vm from 'node:vm';

const [toolPath, paramsJson] = process.argv.slice(2);
const say = (v) => { try { fs.writeSync(3, JSON.stringify(v) + '\\n'); } catch {} };
const captured = (...a) => { try { console.log('[tool]', ...a); } catch {} };

let code;
try { code = fs.readFileSync(toolPath, 'utf8'); } catch (e) {
  say({ ok: false, stage: 'import', error: 'no se pudo leer tool.js: ' + String(e && e.message ? e.message : e) });
  process.exit(0);
}

const guestConsole = { log: captured, info: captured, warn: captured, error: captured, debug: captured };
const ctx = vm.createContext({
  console: guestConsole,
  TextEncoder, TextDecoder, atob, btoa, URL, URLSearchParams, structuredClone,
  queueMicrotask, crypto,
  setTimeout, clearTimeout, setInterval, clearInterval,
});

let mod;
try {
  mod = new vm.SourceTextModule(code, { context: ctx, identifier: toolPath });
  await mod.link((specifier) => { throw new Error('imports denegados en herramientas de fabrica (v1 solo computo): ' + specifier); });
  await mod.evaluate();
} catch (e) {
  say({ ok: false, stage: 'import', error: String(e && e.stack ? e.stack : e) });
  process.exit(0);
}

const ns = mod.namespace;
const bad = (msg) => { say({ ok: false, stage: 'shape', error: msg }); process.exit(0); };
if (typeof ns.name !== 'string' || !ns.name) bad('export name debe ser string no vacio');
if (typeof ns.description !== 'string' || !ns.description) bad('export description debe ser string no vacio');
if (!ns.parameters || typeof ns.parameters !== 'object' || ns.parameters.type !== 'object') bad('export parameters debe ser un JSON schema de objeto ({ type: "object", ... })');
if (typeof ns.run !== 'function') bad('falta export async function run(params)');

let params = {};
try { params = paramsJson ? JSON.parse(paramsJson) : {}; } catch (e) {
  say({ ok: false, stage: 'run', error: 'sampleParams no es JSON valido: ' + String(e) });
  process.exit(0);
}

// Keep the event loop alive while run() is in flight: Node exits fast on an
// unsettled top-level await, which would bypass the parent's timeout and
// mislabel a hang as a supervisor failure. Cleared when run() settles.
const keepAlive = setInterval(() => {}, 60000);
try {
  const result = await ns.run(params);
  clearInterval(keepAlive);
  const text = typeof result === 'string' ? result : (result && typeof result.text === 'string' ? result.text : JSON.stringify(result));
  say({
    ok: true, stage: 'run', text: String(text).slice(0, 4000),
    contract: { name: ns.name, description: ns.description, parameters: ns.parameters },
  });
} catch (e) {
  clearInterval(keepAlive);
  say({ ok: false, stage: 'run', error: String(e && e.stack ? e.stack : e) });
}
`;

function tail(s: string): string {
  return s.length <= LOG_TAIL_BYTES
    ? s
    : `...[${s.length - LOG_TAIL_BYTES} chars cortados]\n${s.slice(-LOG_TAIL_BYTES)}`;
}

export async function runFactoryToolSandboxed(
  id: string,
  params: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<FactoryTestResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const dir = resolve(factoryDir(id));
  const supervisorPath = join(dir, '.supervisor.mjs');
  writeFileSync(supervisorPath, SUPERVISOR_SOURCE);
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-vm-modules',
        '--no-warnings',
        '--permission',
        `--allow-fs-read=${dir}`,
        supervisorPath,
        join(dir, 'tool.js'),
        params === undefined ? '' : JSON.stringify(params),
      ],
      // detached: own process group, so a timeout/output kill reaches the
      // whole tree, not just the direct child. env: empty on purpose.
      { cwd: dir, env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true },
    );
    let logs = '';
    let verdictRaw = '';
    let settled = false;
    const finish = (r: FactoryTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(r);
    };
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      finish({
        ok: false,
        stage: 'timeout',
        output: `${tail(logs)}\n[timeout ${timeoutMs}ms: grupo de procesos muerto]`,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);
    const onLog = (d: Buffer) => {
      logs += d.toString();
      if (Buffer.byteLength(logs) > MAX_FACTORY_OUTPUT_BYTES) {
        killGroup();
        finish({
          ok: false,
          stage: 'output',
          output: `${tail(logs)}\n[salida > ${MAX_FACTORY_OUTPUT_BYTES} bytes: grupo de procesos muerto]`,
          durationMs: Date.now() - started,
        });
      }
    };
    child.stdout?.on('data', onLog);
    child.stderr?.on('data', onLog);
    const verdictStream = child.stdio[3];
    if (verdictStream)
      verdictStream.on('data', (d: Buffer) => {
        verdictRaw += d.toString();
      });
    child.on('error', (e) =>
      finish({
        ok: false,
        stage: 'supervisor',
        output: String(e),
        durationMs: Date.now() - started,
      }),
    );
    child.on('close', (exitCode) => {
      if (settled) return;
      const line = verdictRaw.trim().split('\n').pop() ?? '';
      interface SupervisorVerdict {
        ok?: boolean;
        stage?: string;
        text?: string;
        error?: string;
        contract?: FactoryToolContract;
      }
      let parsed: SupervisorVerdict | null = null;
      try {
        parsed = JSON.parse(line) as SupervisorVerdict | null;
      } catch {
        /* not our verdict */
      }
      const validStages = new Set(['import', 'shape', 'run']);
      if (
        exitCode === 0 &&
        parsed &&
        typeof parsed.ok === 'boolean' &&
        typeof parsed.stage === 'string' &&
        validStages.has(parsed.stage)
      ) {
        finish({
          ok: parsed.ok,
          stage: parsed.stage as FactoryRunStage,
          output: String((parsed.ok ? parsed.text : parsed.error) ?? tail(logs)),
          durationMs: Date.now() - started,
          ...(parsed.contract ? { contract: parsed.contract } : {}),
        });
      } else {
        finish({
          ok: false,
          stage: 'supervisor',
          output: tail(logs) || `el supervisor no produjo veredicto (exit ${String(exitCode)})`,
          durationMs: Date.now() - started,
        });
      }
    });
  });
}

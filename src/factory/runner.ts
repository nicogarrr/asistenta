/**
 * Sandboxed execution of factory-built tools, used BOTH for the mandatory
 * pre-install test and for every post-install call. The authored module never
 * runs in the daemon process, and inside the child it runs as a guest with no
 * capabilities at all: a node:vm SourceTextModule whose context receives ZERO
 * host objects. Any host function injected into a vm context leaks the host
 * Function via .constructor (setTimeout.constructor('return process')()) and
 * with it the whole child process - fd 3, fs despite --permission, real
 * network. So the context is created empty and every helper the guest gets
 * (console capture, params) is code evaluated INSIDE the context, creating
 * guest-realm objects only. The guest is pure ECMAScript: no process, no
 * require, no fetch, no timers, no crypto, and no imports of any kind (the
 * linker denies them). Network note: Node 24 has no --allow-net (lands in
 * 25+), so the network boundary is this capability discipline plus the import
 * denial - a pure-JS guest has no socket API to call.
 *
 * The verdict protocol is outside the module's control: only the supervisor
 * (our trusted code in the child) writes it, on fd 3, and the parent accepts
 * the FIRST valid verdict line (a guest that somehow reached fd 3 later could
 * only append, never overwrite). Guest console output is captured in-context
 * and drained by the supervisor as '[tool]' log lines.
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
  /** Contract read from the executed module (only on ok). Persisted in TOOL.md; the loader uses it so it never imports guest code in the daemon. */
  contract?: FactoryToolContract;
}

/** Cap on captured child output. */
export const MAX_FACTORY_OUTPUT_BYTES = 1024 * 1024;
const LOG_TAIL_BYTES = 4000;

/**
 * Trusted supervisor: the only code that writes the verdict (fd 3). Runs
 * under --permission with fs limited to the tool dir as a second layer behind
 * the capability-less vm context.
 */
const SUPERVISOR_SOURCE = `
import fs from 'node:fs';
import vm from 'node:vm';

const [toolPath, paramsJson] = process.argv.slice(2);
const say = (v) => { try { fs.writeSync(3, JSON.stringify(v) + '\\n'); } catch {} };

let code;
try { code = fs.readFileSync(toolPath, 'utf8'); } catch (e) {
  say({ ok: false, stage: 'import', error: 'no se pudo leer tool.js: ' + String(e && e.message ? e.message : e) });
  process.exit(0);
}

// Empty context: no host object crosses the boundary.
const ctx = vm.createContext({});
// In-context helpers (guest-realm objects only): console capture into an
// in-context buffer the supervisor drains, and params arriving as a JSON
// string parsed INSIDE the guest (a host object would leak constructors).
vm.runInContext(
  'globalThis.__guestLogs = [];' +
  'globalThis.console = (() => {' +
  '  const push = (a) => { try { __guestLogs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); } catch {} };' +
  '  return { log: (...a) => push(a), info: (...a) => push(a), warn: (...a) => push(a), error: (...a) => push(a), debug: (...a) => push(a) };' +
  '})();',
  ctx,
);
const drainLogs = () => {
  try {
    const out = vm.runInContext('__guestLogs.splice(0).join("\\\\n")', ctx);
    if (out) console.log('[tool]', String(out).split('\\n').join('\\n[tool] '));
  } catch {}
};
vm.runInContext('globalThis.__paramsJson = ' + JSON.stringify(String(paramsJson ?? '')), ctx);

let mod;
try {
  mod = new vm.SourceTextModule(code, { context: ctx, identifier: toolPath });
  await mod.link((specifier) => { throw new Error('imports denegados en herramientas de fabrica (v1 solo computo): ' + specifier); });
  await mod.evaluate();
} catch (e) {
  drainLogs();
  say({ ok: false, stage: 'import', error: String(e && e.stack ? e.stack : e) });
  process.exit(0);
}

const ns = mod.namespace;
const bad = (msg) => { drainLogs(); say({ ok: false, stage: 'shape', error: msg }); process.exit(0); };
if (typeof ns.name !== 'string' || !ns.name) bad('export name debe ser string no vacio');
if (typeof ns.description !== 'string' || !ns.description) bad('export description debe ser string no vacio');
if (!ns.parameters || typeof ns.parameters !== 'object' || ns.parameters.type !== 'object') bad('export parameters debe ser un JSON schema de objeto ({ type: "object", ... })');
if (typeof ns.run !== 'function') bad('falta export async function run(params)');

let params;
try { params = vm.runInContext('JSON.parse(globalThis.__paramsJson || "{}")', ctx); } catch (e) {
  drainLogs();
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
  drainLogs();
  // Only primitives cross back: strings and JSON. Guest objects are
  // stringified, never handed to host callers as live objects.
  const text = typeof result === 'string' ? result : (result && typeof result.text === 'string' ? result.text : JSON.stringify(result));
  say({
    ok: true, stage: 'run', text: String(text).slice(0, 4000),
    contract: { name: String(ns.name), description: String(ns.description), parameters: JSON.parse(JSON.stringify(ns.parameters)) },
  });
} catch (e) {
  clearInterval(keepAlive);
  drainLogs();
  say({ ok: false, stage: 'run', error: String(e && e.stack ? e.stack : e) });
}
`;

function tail(s: string): string {
  return s.length <= LOG_TAIL_BYTES
    ? s
    : `...[${s.length - LOG_TAIL_BYTES} chars cortados]\n${s.slice(-LOG_TAIL_BYTES)}`;
}

interface SupervisorVerdict {
  ok?: boolean;
  stage?: string;
  text?: string;
  error?: string;
  contract?: FactoryToolContract;
}

const VERDICT_STAGES = new Set(['import', 'shape', 'run']);

/**
 * Picks the verdict the supervisor wrote: the FIRST line that parses as a
 * valid verdict. A guest with hypothetical post-verdict access to fd 3 could
 * only append lines; the first valid one is the supervisor's.
 */
export function pickVerdict(verdictRaw: string): SupervisorVerdict | null {
  for (const line of verdictRaw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as SupervisorVerdict;
      if (
        parsed &&
        typeof parsed.ok === 'boolean' &&
        typeof parsed.stage === 'string' &&
        VERDICT_STAGES.has(parsed.stage)
      ) {
        return parsed;
      }
    } catch {
      /* not a verdict line */
    }
  }
  return null;
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
      const verdict = pickVerdict(verdictRaw);
      if (exitCode === 0 && verdict) {
        finish({
          ok: verdict.ok as boolean,
          stage: verdict.stage as FactoryRunStage,
          output: String((verdict.ok ? verdict.text : verdict.error) ?? tail(logs)),
          durationMs: Date.now() - started,
          ...(verdict.contract ? { contract: verdict.contract } : {}),
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

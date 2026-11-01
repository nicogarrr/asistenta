/**
 * Sandboxed execution of factory-built tools, used BOTH for the mandatory
 * pre-install test and for every post-install call. R4 architecture: TWO
 * child processes with the verdict channel physically out of the guest's
 * reach.
 *
 *   daemon --(stdio fd 3)--> VERIFIER child --(stdin payload)--> GUEST child
 *
 * The VERIFIER is the only process that can write the verdict (fd 3). It
 * never runs guest code: it reads tool.js, spawns the GUEST with stdio
 * ['pipe','pipe','pipe'] - NO fd 3 - and composes the verdict from the
 * guest's report after validating it. The GUEST runs the vm and the authored
 * module. A guest that escapes its sandbox (even a zero-day vm escape) finds
 * a process with no fd 3, no fs (--permission without allowances beyond
 * reading its own entry file), no child_process, no workers: it cannot forge
 * the verdict channel, read or write outside the tool dir, nor spawn. The
 * report it sends the verifier is, by design, tool-authored content (the
 * contract is the tool's self-declaration); the verifier re-validates shape
 * and clamps every field instead of trusting the report blindly.
 *
 * Inside the guest the vm context is created from Object.create(null) and
 * receives ZERO host objects: any host object injected into a vm context
 * leaks the host Function via .constructor, and R3 proved the contextified
 * global itself bridges to the host realm through its prototype chain
 * (globalThis.constructor -> host Object -> host Function -> process). A
 * null-prototype global kills that chain; every helper the guest gets
 * (console capture, params) is code evaluated INSIDE the context, creating
 * guest-realm objects only. The guest is pure ECMAScript: no process, no
 * require, no fetch, no timers, no crypto, and no imports of any kind (the
 * linker denies them).
 *
 * KNOWN LIMITATION - network: Node 24 has no --allow-net (lands in 25+) and
 * unshare/netns is EPERM in our container, so there is no kernel-level
 * network boundary. A pure-JS guest has no socket API to call (no fetch, no
 * imports), but a guest with a successful vm escape could reach node:net
 * from the guest process. That residual is bounded by everything else the
 * escape does NOT get (no fs, no spawn, no fd 3) and is documented here
 * instead of claiming an isolation we do not have.
 *
 * The verdict protocol: only the verifier writes on fd 3, and the parent
 * accepts the FIRST valid verdict line (a later line can only append, never
 * overwrite). Guest console output is captured in-context, drained by the
 * guest trampoline as '[tool]' lines and forwarded by the verifier as logs.
 *
 * Resource bounds: a wall-clock timeout kills the whole process group (the
 * verifier is spawned detached, the guest belongs to its group), and
 * captured output is capped - a flood kills the run instead of eating
 * daemon memory.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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
 * Console output a guest may buffer INSIDE its sandbox before the run is cut
 * (stage 'output'). Enforced in the guest's own realm, so a tool that logs in
 * a loop can no longer grow memory without bound until run() ends; the 1 MB
 * pipe cap above stays as the outer limit.
 */
export const MAX_GUEST_LOG_CHARS = 256 * 1024;
/** Old-space heap ceiling (MB) for the guest process that runs tool code. */
export const GUEST_HEAP_MB = 256;
/** How often the guest trampoline streams buffered console lines out. */
const GUEST_LOG_PUMP_MS = 200;

/**
 * Trusted verifier: the only code that writes the verdict (fd 3). It runs NO
 * guest code - it reads tool.js, spawns the guest child WITHOUT fd 3 and
 * validates the guest's report before composing the verdict. Runs under
 * --permission with fs read limited to the tool dir plus --allow-child-process
 * (it must spawn the guest).
 */
const VERIFIER_SOURCE = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [toolPath, guestPath, paramsJson] = process.argv.slice(2);
const say = (v) => { try { fs.writeSync(3, JSON.stringify(v) + '\\n'); } catch {} };
const STAGES = new Set(['import', 'shape', 'run', 'output']);
let said = false;
const sayOnce = (v) => { if (said) return; said = true; say(v); process.exit(0); };

let code;
try { code = fs.readFileSync(toolPath, 'utf8'); } catch (e) {
  sayOnce({ ok: false, stage: 'import', error: 'no se pudo leer tool.js: ' + String(e && e.message ? e.message : e) });
}

const dir = path.dirname(toolPath);
const guest = spawn(
  process.execPath,
  // Heap ceiling for guest code: a tool that allocates without bound dies on
  // its own (no report -> 'supervisor') instead of taking the PC's memory.
  ['--experimental-vm-modules', '--no-warnings', '--max-old-space-size=${GUEST_HEAP_MB}', '--permission', '--allow-fs-read=' + dir, guestPath],
  // NO fd 3 here: the guest process physically lacks the verdict channel.
  { stdio: ['pipe', 'pipe', 'pipe'], env: {} },
);

let report = null;
let buf = '';
guest.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!report && line.startsWith('FACTORY-RESULT:')) {
      try {
        const p = JSON.parse(line.slice('FACTORY-RESULT:'.length));
        if (p && typeof p.ok === 'boolean') report = p;
      } catch {}
    } else if (line.length) {
      process.stdout.write(line + '\\n');
    }
  }
});
guest.stderr.on('data', (d) => process.stderr.write(d));
guest.on('error', (e) => sayOnce({ ok: false, stage: 'supervisor', error: 'el guest no arranco: ' + String(e) }));
guest.on('close', (exitCode) => {
  if (buf.trim().length) process.stdout.write(buf + (buf.endsWith('\\n') ? '' : '\\n'));
  if (!report) {
    sayOnce({ ok: false, stage: 'supervisor', error: 'el guest no produjo informe (exit ' + String(exitCode) + ')' });
  }
  if (!report.ok) {
    sayOnce({
      ok: false,
      stage: STAGES.has(report.stage) ? report.stage : 'supervisor',
      error: String(report.error ?? '').slice(0, 4000).replace(/[\\uD800-\\uDBFF]$/, ''),
    });
  }
  // Re-validate the self-declared contract instead of trusting ok blindly.
  const c = report.contract && typeof report.contract === 'object' ? report.contract : {};
  const valid =
    typeof c.name === 'string' && c.name.length > 0 &&
    typeof c.description === 'string' && c.description.length > 0 &&
    c.parameters && typeof c.parameters === 'object' && c.parameters.type === 'object';
  if (!valid) {
    sayOnce({ ok: false, stage: 'shape', error: 'contrato invalido en el informe del guest' });
  }
  sayOnce({
    ok: true,
    stage: 'run',
    text: String(report.text ?? '').slice(0, 4000).replace(/[\\uD800-\\uDBFF]$/, ''),
    contract: { name: c.name, description: c.description, parameters: JSON.parse(JSON.stringify(c.parameters)) },
  });
});
guest.stdin.on('error', () => {});
guest.stdin.end(JSON.stringify({ code, paramsJson: paramsJson ?? '' }));
`;

/**
 * Guest trampoline: runs INSIDE the guest child (no fd 3). Creates the
 * null-prototype vm context, evaluates the module, and emits ONE report line
 * ('FACTORY-RESULT:<json>') on stdout for the verifier. All values in the
 * report are primitives (JSON pipe), and the contract is the tool's own
 * self-declaration - the integrity boundary is the verdict channel, which
 * this process cannot reach.
 */
const GUEST_SOURCE = `
import vm from 'node:vm';

let emitted = false;
const emit = (v) => {
  if (emitted) return;
  emitted = true;
  try { process.stdout.write('FACTORY-RESULT:' + JSON.stringify(v) + '\\n'); } catch {}
};
let pump = null;

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  main(buf)
    .then(
      () => {},
      (e) => emit({ ok: false, stage: 'supervisor', error: String(e && e.stack ? e.stack : e) }),
    )
    .finally(() => { if (pump) clearInterval(pump); });
});

async function main(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch (e) {
    emit({ ok: false, stage: 'import', error: 'payload invalido: ' + String(e) });
    return;
  }
  const code = String(payload.code ?? '');
  const paramsJson = String(payload.paramsJson ?? '');

  // Null-prototype global: the R3 bridge (globalThis.constructor -> host
  // Object -> host Function -> process) starts at the global's prototype.
  const ctx = vm.createContext(Object.create(null));
  vm.runInContext('try { Object.setPrototypeOf(globalThis, null); } catch {}', ctx);
  // In-context helpers (guest-realm objects only): console capture into an
  // in-context buffer the trampoline drains, and params arriving as a JSON
  // string parsed INSIDE the guest (a host object would leak constructors).
  // The buffer and its counter live in a closure; the guest only sees two
  // frozen accessors, so it cannot reset the count. Past the cap every
  // console call throws, which also breaks a synchronous logging loop.
  vm.runInContext(
    '(() => {' +
    '  const cap = ${MAX_GUEST_LOG_CHARS};' +
    '  let logs = []; let used = 0; let over = false;' +
    '  const fail = () => { throw new Error("salida del tool > " + cap + " caracteres"); };' +
    '  const push = (a) => {' +
    '    if (over) fail();' +
    '    let line;' +
    '    try { line = String(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); } catch { return; }' +
    '    if (used + line.length > cap) { logs.push(line.slice(0, cap - used)); used = cap; over = true; fail(); }' +
    '    used += line.length; logs.push(line);' +
    '  };' +
    '  const fix = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: false, configurable: false, enumerable: false });' +
    '  fix("__guestDrain", () => { const out = logs.join("\\\\n"); logs = []; return out; });' +
    '  fix("__guestOver", () => over);' +
    '  globalThis.console = { log: (...a) => push(a), info: (...a) => push(a), warn: (...a) => push(a), error: (...a) => push(a), debug: (...a) => push(a) };' +
    '})();',
    ctx,
  );
  let overflowed = false;
  const OVERFLOW = 'salida del tool > ${MAX_GUEST_LOG_CHARS} caracteres: ejecucion cortada dentro del sandbox';
  const drainLogs = () => {
    try {
      const out = String(vm.runInContext('__guestDrain()', ctx));
      if (out) console.log('[tool]', out.split('\\n').join('\\n[tool] '));
      if (vm.runInContext('__guestOver()', ctx) === true) overflowed = true;
    } catch {}
  };
  // Final report: drain first, and an overflow outranks whatever the tool did
  // afterwards (even a tool that swallowed the console error and returned).
  const finishWith = (v) => {
    drainLogs();
    emit(overflowed ? { ok: false, stage: 'output', error: OVERFLOW } : v);
  };
  // Stream console lines while the tool runs (a tool that logs and then hangs
  // shows its lines on timeout) and stop at once on overflow. Also keeps the
  // event loop alive: Node exits fast on an unsettled top-level await, which
  // would bypass the parent's timeout and mislabel a hang as a supervisor
  // failure. Cleared when main() settles.
  pump = setInterval(() => {
    drainLogs();
    if (overflowed) {
      emit({ ok: false, stage: 'output', error: OVERFLOW });
      clearInterval(pump);
    }
  }, ${GUEST_LOG_PUMP_MS});
  vm.runInContext('globalThis.__paramsJson = ' + JSON.stringify(paramsJson), ctx);

  let mod;
  try {
    mod = new vm.SourceTextModule(code, { context: ctx, identifier: 'tool.js' });
    await mod.link((specifier) => { throw new Error('imports denegados en herramientas de fabrica (v1 solo computo): ' + specifier); });
    await mod.evaluate();
  } catch (e) {
    finishWith({ ok: false, stage: 'import', error: String(e && e.stack ? e.stack : e) });
    return;
  }

  const ns = mod.namespace;
  const bad = (msg) => finishWith({ ok: false, stage: 'shape', error: msg });
  if (typeof ns.name !== 'string' || !ns.name) return bad('export name debe ser string no vacio');
  if (typeof ns.description !== 'string' || !ns.description) return bad('export description debe ser string no vacio');
  if (!ns.parameters || typeof ns.parameters !== 'object' || ns.parameters.type !== 'object') return bad('export parameters debe ser un JSON schema de objeto ({ type: "object", ... })');
  if (typeof ns.run !== 'function') return bad('falta export async function run(params)');

  let params;
  try { params = vm.runInContext('JSON.parse(globalThis.__paramsJson || "{}")', ctx); } catch (e) {
    finishWith({ ok: false, stage: 'run', error: 'sampleParams no es JSON valido: ' + String(e) });
    return;
  }

  try {
    const result = await ns.run(params);
    // Only primitives cross back: strings and JSON. Guest objects are
    // stringified, never handed to host callers as live objects.
    const text = typeof result === 'string' ? result : (result && typeof result.text === 'string' ? result.text : JSON.stringify(result));
    finishWith({
      ok: true, stage: 'run', text: String(text).slice(0, 4000).replace(/[\\uD800-\\uDBFF]$/, ''),
      contract: { name: String(ns.name), description: String(ns.description), parameters: JSON.parse(JSON.stringify(ns.parameters)) },
    });
  } catch (e) {
    finishWith({ ok: false, stage: 'run', error: String(e && e.stack ? e.stack : e) });
  }
}
`;

/**
 * Collects the child's stdout/stderr for the parent side of the sandbox.
 * Bytes are counted as they arrive (chunk.length), so the cap check is O(1)
 * per chunk instead of re-measuring everything collected so far, and each
 * stream has its own UTF-8 decoder so a character split across two pipe
 * chunks («á», «ñ», emoji) is not turned into replacement characters.
 */
export interface OutputCollector {
  /** Bytes received so far across all streams. */
  readonly bytes: number;
  /** Adds a chunk on a default stream; returns true once bytes > maxBytes. */
  push(chunk: Buffer): boolean;
  /** A writer for one stream with its own decoder; returns true once over the cap. */
  stream(): (chunk: Buffer) => boolean;
  /** Text collected so far. */
  text(): string;
}

export function createOutputCollector(maxBytes: number): OutputCollector {
  let bytes = 0;
  let text = '';
  const stream = (): ((chunk: Buffer) => boolean) => {
    const decoder = new StringDecoder('utf8');
    return (chunk: Buffer) => {
      bytes += chunk.length;
      text += decoder.write(chunk);
      return bytes > maxBytes;
    };
  };
  const def = stream();
  return {
    get bytes() {
      return bytes;
    },
    push: def,
    stream,
    text: () => text,
  };
}

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

const VERDICT_STAGES = new Set(['import', 'shape', 'run', 'output']);

/**
 * Picks the verdict the verifier wrote: the FIRST line that parses as a
 * valid verdict. A later line could only append, never overwrite.
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
        VERDICT_STAGES.has(parsed.stage) &&
        // Only a finished run can be a success: «ok» with any other stage
        // is malformed, not a verdict.
        (parsed.ok === false || (parsed.stage === 'run' && typeof parsed.text === 'string'))
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
  const verifierPath = join(dir, '.verifier.mjs');
  const guestPath = join(dir, '.guest.mjs');
  writeFileSync(verifierPath, VERIFIER_SOURCE);
  writeFileSync(guestPath, GUEST_SOURCE);
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--permission',
        '--allow-child-process',
        `--allow-fs-read=${dir}`,
        verifierPath,
        join(dir, 'tool.js'),
        guestPath,
        params === undefined ? '' : JSON.stringify(params),
      ],
      // detached: own process group, so a timeout/output kill reaches the
      // whole tree (verifier + guest), not just the direct child. env: empty
      // on purpose.
      { cwd: dir, env: {}, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true },
    );
    const collected = createOutputCollector(MAX_FACTORY_OUTPUT_BYTES);
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
        output: `${tail(collected.text())}\n[timeout ${timeoutMs}ms: grupo de procesos muerto]`,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);
    const onOverflow = () => {
      killGroup();
      finish({
        ok: false,
        stage: 'output',
        output: `${tail(collected.text())}\n[salida > ${MAX_FACTORY_OUTPUT_BYTES} bytes: grupo de procesos muerto]`,
        durationMs: Date.now() - started,
      });
    };
    const outWriter = collected.stream();
    const errWriter = collected.stream();
    child.stdout?.on('data', (d: Buffer) => {
      if (outWriter(d)) onOverflow();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errWriter(d)) onOverflow();
    });
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
          output: String((verdict.ok ? verdict.text : verdict.error) ?? tail(collected.text())),
          durationMs: Date.now() - started,
          ...(verdict.contract ? { contract: verdict.contract } : {}),
        });
      } else {
        finish({
          ok: false,
          stage: 'supervisor',
          output:
            tail(collected.text()) ||
            `el supervisor no produjo veredicto (exit ${String(exitCode)})`,
          durationMs: Date.now() - started,
        });
      }
    });
  });
}

/**
 * Subprocess test for a factory-built tool. Nothing the agent authored enters
 * the daemon process before this passes: the module is imported and executed
 * by a throwaway `node` child with a scrubbed environment (no daemon secrets,
 * no config), a timeout, and all output captured into `test.log`.
 *
 * The authored module contract (`tool.js`):
 *
 *   export const name = 'mi-tool';
 *   export const description = '...';
 *   export const parameters = { type: 'object', properties: { ... } }; // JSON schema
 *   export async function run(params) { return { text: '...' }; }       // or a string
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factoryDir } from './store.js';

export interface FactoryTestResult {
  ok: boolean;
  /** Where it failed: import (syntax), shape (contract), or run (execution). */
  stage: 'import' | 'shape' | 'run' | 'timeout';
  output: string;
  durationMs: number;
}

const RUNNER_SOURCE = `
const [toolPath, paramsJson] = process.argv.slice(2);
const fail = (stage, err) => {
  console.log(JSON.stringify({ ok: false, stage, error: String(err && err.stack ? err.stack : err) }));
  process.exit(0);
};
let mod;
try {
  mod = await import(toolPath);
} catch (err) { fail('import', err); }
if (typeof mod.name !== 'string' || !mod.name) fail('shape', 'export name debe ser string no vacio');
if (typeof mod.description !== 'string' || !mod.description) fail('shape', 'export description debe ser string no vacio');
if (!mod.parameters || typeof mod.parameters !== 'object' || mod.parameters.type !== 'object') {
  fail('shape', 'export parameters debe ser un JSON schema de objeto ({ type: "object", ... })');
}
if (typeof mod.run !== 'function') fail('shape', 'falta export async function run(params)');
let params = {};
try { params = paramsJson ? JSON.parse(paramsJson) : {}; } catch (err) { fail('run', 'sampleParams no es JSON valido: ' + err); }
// Keep the event loop alive while run() is in flight: Node exits fast with an
// "unsettled top-level await" warning when run() never settles, which would
// bypass the parent timeout and mislabel the hang as an import failure. The
// interval is cleared on completion so a finished tool exits normally.
const keepAlive = setInterval(() => {}, 60000);
try {
  const result = await mod.run(params);
  clearInterval(keepAlive);
  const text = typeof result === 'string' ? result : (result && typeof result.text === 'string' ? result.text : JSON.stringify(result));
  console.log(JSON.stringify({ ok: true, stage: 'run', text: String(text).slice(0, 4000) }));
} catch (err) { clearInterval(keepAlive); fail('run', err); }
`;

/** Only what a compute/data tool legitimately needs. No daemon env, no keys. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'windir',
    'ComSpec',
    'NUMBER_OF_PROCESSORS',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export async function testFactoryTool(
  id: string,
  sampleParams: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<FactoryTestResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const dir = factoryDir(id);
  const runnerPath = join(dir, '.runner.mjs');
  writeFileSync(runnerPath, RUNNER_SOURCE);
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        runnerPath,
        join(dir, 'tool.js'),
        sampleParams === undefined ? '' : JSON.stringify(sampleParams),
      ],
      { cwd: dir, env: scrubbedEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: FactoryTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        stage: 'timeout',
        output: `${out + err}\n[timeout ${timeoutMs}ms]`,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) =>
      finish({ ok: false, stage: 'run', output: String(e), durationMs: Date.now() - started }),
    );
    child.on('close', () => {
      const line = out.trim().split('\n').pop() ?? '';
      try {
        const parsed = JSON.parse(line) as {
          ok: boolean;
          stage?: string;
          error?: string;
          text?: string;
        };
        finish({
          ok: parsed.ok,
          stage: (parsed.stage as FactoryTestResult['stage']) ?? 'run',
          output: (parsed.ok ? parsed.text : parsed.error) ?? out + err,
          durationMs: Date.now() - started,
        });
      } catch {
        finish({
          ok: false,
          stage: 'import',
          output: out + err || 'el runner no produjo JSON',
          durationMs: Date.now() - started,
        });
      }
    });
  });
}

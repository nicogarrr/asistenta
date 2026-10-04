import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Measurement } from './score.js';

/**
 * Measuring a tree, the same way every time.
 *
 * A loop that measures differently before and after will promote whatever it likes, so
 * this runs exactly two things and reports them as one number: the test suite, and the
 * offline end-to-end probes. Both are offline and deterministic by design, which is what
 * makes them comparable across weeks on a machine that also runs Telegram, a browser and a
 * microphone.
 *
 * Nothing here reaches the network or the user's chat. A measurement that sent a test
 * message or moved a file would be measuring the side effects, not the change.
 */

const exec = promisify(execFile);

/**
 * The environment a candidate's code runs with. The candidate is code a model wrote, run by
 * vitest and tsx, so it gets the minimum to run and nothing that opens an account: no API
 * keys, no tokens, no vault or state paths.
 */
const SAFE_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'DISPLAY',
  'LANG',
  'CI',
];
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NODE_ENV: 'test' };
  for (const k of SAFE_ENV) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

export interface MeasureOptions {
  cwd: string;
  /** Full test suite. Off for a quick inner iteration. */
  suite?: boolean;
  timeoutMs?: number;
}

/** Parse vitest's summary line, e.g. `Tests  12 passed | 1 failed (13)`. */
export function parseSuite(output: string): { passed: number; failed: number } {
  const line = output
    .split('\n')
    .reverse()
    .find((l) => /Tests\s+.*\d+ (passed|failed)/.test(l) || /Test Files.*\d+ failed/.test(l));
  if (!line) return { passed: 0, failed: 0 };
  const passed = [...line.matchAll(/(\d+)\s+passed/g)].reduce((n, m) => n + Number(m[1]), 0);
  const failed = [...line.matchAll(/(\d+)\s+failed/g)].reduce((n, m) => n + Number(m[1]), 0);
  return { passed, failed };
}

/** Parse the generic-flow probe, which prints `PASA <name>` / `FALLA <name>` per check. */
export function parseChecks(output: string): { passed: number; failed: number } {
  const passed = (output.match(/^PASA /gm) ?? []).length;
  const failed = (output.match(/^FALLA /gm) ?? []).length;
  return { passed, failed };
}

export async function measure(opts: MeasureOptions): Promise<Measurement> {
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const started = Date.now();
  let passed = 0;
  let failed = 0;
  let checks = 0;
  let checksFailed = 0;

  try {
    const suite = await exec('npx', ['vitest', '--run', '--reporter=basic'], {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      env: cleanEnv(),
      maxBuffer: 32 * 1024 * 1024,
    }).catch((err: { stdout?: string; stderr?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }));
    const parsed = parseSuite(`${suite.stdout}\n${suite.stderr}`);
    passed = parsed.passed;
    failed = parsed.failed;
  } catch (err) {
    return {
      passed: 0,
      failed: 0,
      checks: 0,
      checksFailed: 0,
      durationMs: Date.now() - started,
      error: `no se pudo ejecutar la suite: ${(err as Error).message.slice(0, 200)}`,
    };
  }

  // The probes are the offline stand-in for the real flows. A failure here is worth more
  // than a failed unit test, and score.ts already prices it that way.
  const probe = await exec('npx', ['tsx', 'evolve/probe-generic-flow.ts'], {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    env: cleanEnv(),
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: { stdout?: string; stderr?: string }) => ({
    stdout: err.stdout ?? '',
    stderr: err.stderr ?? '',
  }));
  const parsedChecks = parseChecks(`${probe.stdout}\n${probe.stderr}`);
  checks = parsedChecks.passed;
  checksFailed = parsedChecks.failed;

  return { passed, failed, checks, checksFailed, durationMs: Date.now() - started };
}

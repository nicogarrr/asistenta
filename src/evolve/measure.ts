import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  'DISPLAY',
  'LANG',
  'CI',
];
/**
 * The user's home is NOT passed through: the vault file and the profile live under it. The
 * candidate gets an empty throwaway home, so reading the user's real files from disk finds
 * nothing.
 */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NODE_ENV: 'test' };
  for (const k of SAFE_ENV) if (env[k] !== undefined) out[k] = env[k];
  if (home) {
    out.HOME = home;
    out.USERPROFILE = home;
    out.APPDATA = join(home, 'AppData', 'Roaming');
    out.LOCALAPPDATA = join(home, 'AppData', 'Local');
    out.XDG_CONFIG_HOME = join(home, '.config');
    out.XDG_CACHE_HOME = join(home, '.cache');
  }
  return out;
}

/** Per-test outcome from vitest's JSON report: keys of tests that passed and that failed. */
export function parseJsonReport(text: string): {
  passing: string[];
  failing: string[];
} | null {
  try {
    const j = JSON.parse(text) as {
      testResults?: Array<{
        name: string;
        assertionResults?: Array<{ fullName?: string; title?: string; status: string }>;
      }>;
    };
    const passing: string[] = [];
    const failing: string[] = [];
    for (const f of j.testResults ?? []) {
      const file = f.name.replace(/\\/g, '/').replace(/^.*\/test\//, 'test/');
      for (const a of f.assertionResults ?? []) {
        const key = `${file}::${a.fullName ?? a.title ?? '?'}`;
        if (a.status === 'passed') passing.push(key);
        else if (a.status === 'failed') failing.push(key);
      }
    }
    return { passing, failing };
  } catch {
    return null;
  }
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

  const home = mkdtempSync(join(tmpdir(), 'evolve-home-'));
  const reportFile = join(home, 'vitest-report.json');
  let names: { passing: string[]; failing: string[] } | null = null;
  try {
    const suite = await exec(
      'npx',
      ['vitest', '--run', '--reporter=basic', '--reporter=json', `--outputFile.json=${reportFile}`],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        env: cleanEnv(process.env, home),
        maxBuffer: 32 * 1024 * 1024,
      },
    ).catch((err: { stdout?: string; stderr?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }));
    try {
      names = parseJsonReport(readFileSync(reportFile, 'utf8'));
    } catch {
      names = null;
    }
    const parsed = parseSuite(`${suite.stdout}\n${suite.stderr}`);
    passed = parsed.passed;
    failed = parsed.failed;
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
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
    env: cleanEnv(process.env, home),
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: { stdout?: string; stderr?: string }) => ({
    stdout: err.stdout ?? '',
    stderr: err.stderr ?? '',
  }));
  const parsedChecks = parseChecks(`${probe.stdout}\n${probe.stderr}`);
  checks = parsedChecks.passed;
  checksFailed = parsedChecks.failed;

  rmSync(home, { recursive: true, force: true });
  return {
    passed,
    failed,
    checks,
    checksFailed,
    durationMs: Date.now() - started,
    ...(names ? { passingTests: names.passing, failingTests: names.failing } : {}),
  };
}

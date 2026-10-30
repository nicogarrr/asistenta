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
 * keys, no tokens, no inherited HOME (it does not stop reading absolute paths: same OS user).
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

/**
 * Parse vitest's summary, e.g. `Tests  12 passed | 1 failed (13)`.
 *
 * The `Tests` line alone is not the verdict. A test file that cannot even load (a
 * syntax error, a broken import) contributes no tests, so vitest prints
 * `Test Files  1 failed | 3 passed` above an all-green `Tests  30 passed`, and an
 * unhandled rejection is reported on its own `Errors  1 error` line; both make the
 * run fail. Reading only the `Tests` line scored such a candidate as 0 failures, so
 * a change that broke a whole test file looked as good as one that broke nothing.
 */
/** Colour escapes, in case a runner forces colour into a pipe. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function parseSuite(output: string): { passed: number; failed: number } {
  const lines = output.split('\n').map((l) => l.replace(ANSI, ''));
  const last = (re: RegExp) => [...lines].reverse().find((l) => re.test(l));
  const count = (line: string | undefined, word: string) =>
    line
      ? [...line.matchAll(new RegExp(`(\\d+)\\s+${word}`, 'g'))].reduce(
          (n, m) => n + Number(m[1]),
          0,
        )
      : 0;
  const tests = last(/^\s*Tests\s+.*\d+ (passed|failed)/);
  const files = last(/^\s*Test Files\s+.*\d+ (passed|failed)/);
  const errors = last(/^\s*Errors\s+\d+ errors?/);
  if (!tests && !files) return { passed: 0, failed: 0 };
  const passed = count(tests, 'passed');
  // A failed file holds at least one failing test or failed to load, so the file
  // count is a floor for the failures.
  const failed =
    Math.max(count(tests, 'failed'), count(files, 'failed')) + count(errors, 'errors?');
  return { passed, failed };
}

/** Parse the generic-flow probe, which prints `PASA <name>` / `FALLA <name>` per check. */
export function parseChecks(output: string): { passed: number; failed: number } {
  const passed = (output.match(/^PASA /gm) ?? []).length;
  const failed = (output.match(/^FALLA /gm) ?? []).length;
  return { passed, failed };
}

/**
 * Names of the probe checks that passed and failed (the label, without the « — detalle»
 * tail, which can carry timings or page text that change between runs). The judge uses them
 * per check, like the per-test report: a check that passed in the kernel and no longer
 * passes (it fails, or the probe stopped printing it) is a regression whatever the totals say.
 */
export function checkNames(output: string): { passing: string[]; failing: string[] } {
  const passing: string[] = [];
  const failing: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(ANSI, '').replace(/\r$/, '');
    const m = /^(PASA|FALLA) +(.+)$/.exec(line);
    if (!m) continue;
    const name = (m[2] as string).split(/ (?:—|â€”) /)[0]?.trim() ?? '';
    if (!name) continue;
    (m[1] === 'PASA' ? passing : failing).push(name);
  }
  return { passing, failing };
}

/**
 * Why a probe run measured nothing trustworthy, or null when it finished. The probe ends
 * with «FLUJO GENERICO OK» (exit 0) or «N PASO(S) FALLARON» (exit 1). A probe that crashed,
 * was killed or stopped early printed only some checks: counting those as the result scored
 * the steps it never reached as if they did not exist, so the run is reported as not
 * measured instead of as a measurement.
 */
export function probeUnfinished(output: string, code: number | string | null): string | null {
  const lines = output.split('\n').map((l) => l.replace(ANSI, '').replace(/\r$/, '').trim());
  if (code === 0 && lines.includes('FLUJO GENERICO OK')) return null;
  if (code === 1 && lines.some((l) => /^\d+ PASO\(S\) FALLARON$/.test(l))) return null;
  return `la sonda de extremo a extremo no terminó (salida ${code ?? 'sin código'}, sin «FLUJO GENERICO OK»): no medido`;
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
  // The report goes to its own directory with an unpredictable name, not into the home the
  // candidate's tests run with. Same OS user, so this is a mitigation, not a wall: the report
  // is also cross-checked against the runner's own summary line below.
  const reportDir = mkdtempSync(join(tmpdir(), 'evolve-rep-'));
  const reportFile = join(reportDir, `r-${Math.random().toString(36).slice(2)}.json`);
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
    // A report that disagrees with the summary line is not trusted.
    if (
      names &&
      (names.passing.length !== parsed.passed || names.failing.length !== parsed.failed)
    ) {
      names = null;
    }
    passed = parsed.passed;
    failed = parsed.failed;
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    rmSync(reportDir, { recursive: true, force: true });
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
  })
    .then((r) => ({ ...r, code: 0 as number | string | null }))
    .catch((err: { stdout?: string; stderr?: string; code?: number | string | null }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: err.code ?? null,
    }));
  const probeError = probeUnfinished(`${probe.stdout}\n${probe.stderr}`, probe.code);
  const parsedChecks = parseChecks(`${probe.stdout}\n${probe.stderr}`);
  checks = parsedChecks.passed;
  checksFailed = parsedChecks.failed;
  const passingChecks = checkNames(`${probe.stdout}\n${probe.stderr}`).passing;

  rmSync(home, { recursive: true, force: true });
  rmSync(reportDir, { recursive: true, force: true });
  if (!names) {
    // Fail closed: without a per-test report the regression check cannot run, and falling
    // back to counts would let a change that fixes two tests and breaks one through.
    return {
      passed,
      failed,
      checks,
      checksFailed,
      durationMs: Date.now() - started,
      error: 'falta el informe por test (o no coincide con el resumen): no comparable',
    };
  }
  if (probeError) {
    return {
      passed,
      failed,
      checks,
      checksFailed,
      durationMs: Date.now() - started,
      error: probeError,
    };
  }
  return {
    passed,
    failed,
    checks,
    checksFailed,
    durationMs: Date.now() - started,
    passingTests: names.passing,
    failingTests: names.failing,
    passingChecks,
  };
}

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWeek } from '../src/evolve/loop.js';
import { cleanEnv } from '../src/evolve/measure.js';
import { addHypothesis, isEvolveDue, readHypotheses } from '../src/evolve/run.js';
import type { Measurement } from '../src/evolve/score.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

const m = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 100,
  failed: 0,
  checks: 10,
  checksFailed: 0,
  durationMs: 1000,
  passingTests: ['t::a'],
  failingTests: [],
  ...over,
});

let root: string;
let state: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evo-repo-'));
  state = mkdtempSync(join(tmpdir(), 'evo-state-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'permissions.ts'), 'export const gate = true;\n');
  writeFileSync(join(root, 'test', 'a.test.ts'), 'export {};\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

const cycle = (propose: (dir: string) => void, measured: Measurement) =>
  runWeek({
    root,
    stateDir: state,
    maxTries: 1,
    propose: async (dir) => propose(dir),
    hypotheses: async () => ['idea'],
    measure: async (o) => (o.cwd === root ? m() : measured),
  });

describe('evolve: the loop on a real git repo', () => {
  it('discards an UNCOMMITTED edit to a forbidden file (the guard sees the working tree)', async () => {
    const report = await cycle(
      (dir) => writeFileSync(join(dir, 'src', 'permissions.ts'), 'export const gate = false;\n'),
      m({ passed: 200 }),
    );
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.verdict).toBe('discard');
    expect(report.attempts[0]?.reason).toMatch(/permissions\.ts/);
  });

  it('refuses to touch tests, so adding tests cannot inflate the score', async () => {
    const report = await cycle(
      (dir) => writeFileSync(join(dir, 'test', 'extra.test.ts'), 'export {};\n'),
      m({ passed: 200 }),
    );
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/test\//);
  });

  it('refuses a content change that relaxes a gate, even in an allowed file', async () => {
    const report = await cycle(
      (dir) => writeFileSync(join(dir, 'src', 'a.ts'), 'export const autoApprove = true;\n'),
      m({ passed: 200 }),
    );
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.verdict).toBe('discard');
  });

  it('promotes by leaving a branch and a patch, and never merges into main', async () => {
    const before = git(root, 'rev-parse', 'main');
    const report = await cycle(
      (dir) => writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n'),
      m({ checks: 20 }),
    );
    expect(report.promoted).toBe(true);
    expect(report.branch).toMatch(/^evolve\//);
    expect(git(root, 'rev-parse', 'main')).toBe(before);
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    expect(existsSync(report.patchFile ?? '')).toBe(true);
    expect(readFileSync(report.patchFile as string, 'utf8')).toContain('a = 2');
  });

  it('discards an attempt that changed nothing', async () => {
    const report = await cycle(() => {}, m({ checks: 20 }));
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/no cambió nada/);
  });

  it('does not promote a regression even when the total score goes up', async () => {
    const report = await cycle(
      (dir) => writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 3;\n'),
      m({ checks: 40, failed: 1 }),
    );
    expect(report.promoted).toBe(false);
  });
});

describe('evolve: plumbing', () => {
  it('measures with an environment that has no keys', () => {
    const env = cleanEnv({
      PATH: '/bin',
      OPENAI_API_KEY: 'x',
      TELEGRAM_BOT_TOKEN: 'y',
      PA_VAULT_KEY: 'z',
      HOME: '/h',
    });
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PA_VAULT_KEY).toBeUndefined();
  });

  it('is due on Sunday after 03:00, once every six days', () => {
    const sunday = new Date(2026, 9, 4, 4, 0, 0); // domingo 4 oct 2026
    expect(sunday.getDay()).toBe(0);
    expect(isEvolveDue(sunday, 0)).toBe(true);
    expect(isEvolveDue(sunday, sunday.getTime() - 3_600_000)).toBe(false);
    expect(isEvolveDue(new Date(2026, 9, 4, 2, 0, 0), 0)).toBe(false);
    expect(isEvolveDue(new Date(2026, 9, 5, 4, 0, 0), 0)).toBe(false);
  });

  it('keeps the ideas the owner adds, one per line', () => {
    addHypothesis(state, '  acortar   el prompt  ');
    addHypothesis(state, 'mejorar los errores');
    expect(readHypotheses(state)).toEqual(['acortar el prompt', 'mejorar los errores']);
    expect(() => addHypothesis(state, '   ')).toThrow();
  });
});

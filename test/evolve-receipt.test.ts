import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWeek, summarize } from '../src/evolve/loop.js';
import {
  checklistPasses,
  type ReceiptInput,
  renderReceipt,
  verificationChecklist,
} from '../src/evolve/receipt.js';
import type { Measurement } from '../src/evolve/score.js';

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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function repo(): { root: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'evolve-receipt-'));
  const state = mkdtempSync(join(tmpdir(), 'evolve-receipt-state-'));
  dirs.push(root, state);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, state };
}

const input = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({
  week: '2026-W44',
  hypothesis: 'cachear el índice de skills entre turnos',
  attempt: 1,
  kernel: 'abc123',
  branch: 'evolve/w1',
  touched: ['src/a.ts'],
  forbidden: [],
  baseline: m(),
  candidate: m({ passed: 110 }),
  verdictReason: 'mejora',
  delta: 10,
  minGainPct: 5,
  ...over,
});

describe('checklist de verificación (ROADMAP: receipt antes de dar nada por listo)', () => {
  it('un candidato limpio pasa todas las casillas', () => {
    expect(checklistPasses(verificationChecklist(input()))).toBe(true);
  });

  it('sin spec (hipótesis vacía o de una palabra) no pasa', () => {
    expect(checklistPasses(verificationChecklist(input({ hypothesis: '  ' })))).toBe(false);
    expect(checklistPasses(verificationChecklist(input({ hypothesis: 'mejorar' })))).toBe(false);
  });

  it('más fallos que la base, checks rotos o medición con error no pasan', () => {
    for (const candidate of [
      m({ passed: 120, failed: 1 }),
      m({ passed: 120, checksFailed: 1 }),
      m({ passed: 120, error: 'timeout' }),
    ]) {
      expect(checklistPasses(verificationChecklist(input({ candidate })))).toBe(false);
    }
  });

  it('el receipt marca cada casilla y el resultado', () => {
    const items = verificationChecklist(input());
    const md = renderReceipt(input(), items);
    expect(md).toContain('- [x] Spec antes de código');
    expect(md).toContain('checklist completa');
    expect(md).toContain('- src/a.ts');
  });
});

describe('runWeek escribe el receipt y no promueve sin checklist completa', () => {
  it('un promote deja receipt junto al parche', async () => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['subir a de 1 a 2 para cubrir el caso'],
      propose: async (dir) => writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n'),
      measure: async (o) => (o.cwd === root ? m() : m({ passed: 200 })),
    });
    expect(report.promoted).toBe(true);
    expect(report.receiptFile && existsSync(report.receiptFile)).toBe(true);
    const md = readFileSync(report.receiptFile as string, 'utf8');
    expect(md).toContain('subir a de 1 a 2');
    expect(md).not.toContain('- [ ]');
    expect(summarize(report)).toContain('receipt');
  });

  it('sin spec, una mejora que judge promovería se descarta', async () => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['x'],
      propose: async (dir) => writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n'),
      measure: async (o) => (o.cwd === root ? m() : m({ passed: 200 })),
    });
    expect(report.promoted).toBe(false);
    expect(report.receiptFile).toBeUndefined();
    expect(report.attempts[0]?.reason).toMatch(/checklist de verificación incompleta/);
  });
});

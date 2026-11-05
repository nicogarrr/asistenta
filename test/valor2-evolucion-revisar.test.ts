/**
 * Auto-mejora: «revisar antes de aplicar». Un ciclo que promovía un candidato solo decía
 * «Hay un candidato (rama …)»; para verlo o aplicarlo había que ir al PC. Ahora llega una
 * ficha (ficheros, +/−, trozo del diff, verificación) con «📄 Ver parche», «✅ Aplicar» y
 * «🗑 Descartar», y nada entra en la copia sin ese toque. git de verdad en una carpeta
 * temporal.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import type { WeekReport } from '../src/evolve/loop.js';
import {
  applyCandidate,
  candidateFromReport,
  discardCandidate,
  findCandidate,
  fullPatchText,
  gitIn,
  latestCandidate,
  patchStats,
  reviewButtons,
  reviewCard,
  reviewMessage,
} from '../src/evolve/review.js';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Repo con un fichero, un parche promovido sobre él y la carpeta de estado. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'evo-review-'));
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(repo);
  mkdirSync(join(state, 'evolve'), { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'saludo.ts'), "export const hola = 'hola';\n");
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'base');
  writeFileSync(
    join(repo, 'saludo.ts'),
    "export const hola = '¡hola!';\nexport const adios = 'adiós';\n",
  );
  const patch = sh(repo, 'diff');
  sh(repo, 'checkout', '-q', '--', 'saludo.ts');
  const patchFile = join(state, 'evolve', 'promovido-w45-a1.patch');
  writeFileSync(patchFile, patch);
  writeFileSync(
    join(state, 'evolve', 'promovido-w45-a1.receipt.md'),
    '# Receipt\n- [x] tests verdes\n- [x] batería 12/12\n- [ ] revisado por una persona\n',
  );
  return { repo, state, patch, patchFile };
}

const report = (patchFile: string): WeekReport =>
  ({
    week: '2026-W45',
    baseline: { passed: 10, checks: 3 },
    attempts: [
      { hypothesis: 'otra', try: 1, verdict: 'discard', delta: 0, reason: '' },
      { hypothesis: 'saludar con exclamación', try: 1, verdict: 'promote', delta: 6, reason: '' },
    ],
    promoted: true,
    branch: 'evolve/w45-a1',
    patchFile,
  }) as unknown as WeekReport;

describe('auto-mejora: revisar antes de aplicar', () => {
  it('la ficha dice qué cambia: idea, ficheros con +/−, verificación y trozo del diff', () => {
    const { state, patchFile } = setup();
    const c = candidateFromReport(state, report(patchFile));
    expect(c?.id).toBe('w45-a1');
    expect(c?.hypothesis).toBe('saludar con exclamación');
    const { text, buttons } = reviewMessage(c as NonNullable<typeof c>);
    expect(text).toContain('Revísalo antes de aplicarlo');
    expect(text).toContain('Idea: saludar con exclamación');
    expect(text).toContain('• saludo.ts (+2 −1)');
    expect(text).toContain('✅ tests verdes');
    expect(text).toContain('⬜ revisado por una persona');
    expect(text).toContain("+export const adios = 'adiós';");
    expect(text).toContain('Nada se aplica sin tu toque');
    expect(buttons.map((b) => b.label)).toEqual(['📄 Ver parche', '✅ Aplicar', '🗑 Descartar']);
  });

  it('cada botón equivale a teclear la orden, y un ciclo sin candidato no manda ficha', () => {
    const actions = reviewButtons('w45-a1').map((b) => commandFromCallback(b.action));
    expect(actions).toEqual([
      '/evolucion parche w45-a1',
      '/evolucion aplicar w45-a1',
      '/evolucion descartar w45-a1',
    ]);
    expect(commandFromCallback('cmd:evolucion ahora x')).toBeUndefined();
    const { state } = setup();
    expect(
      candidateFromReport(state, { promoted: false, attempts: [] } as unknown as WeekReport),
    ).toBeUndefined();
  });

  it('«✅ Aplicar» lo guarda como un commit local y no deja aplicarlo dos veces', async () => {
    const { repo, state, patchFile } = setup();
    const c = candidateFromReport(state, report(patchFile));
    const r = await applyCandidate(c as NonNullable<typeof c>, gitIn(repo));
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Aplicado como commit [0-9a-f]{7,}/);
    expect(r.text).toContain('git revert');
    expect(readFileSync(join(repo, 'saludo.ts'), 'utf8')).toContain('adiós');
    expect(sh(repo, 'log', '-1', '--format=%s').trim()).toBe(
      'Auto-mejora: saludar con exclamación',
    );
    expect(sh(repo, 'status', '--porcelain').trim()).toBe('');
    expect(findCandidate(state, 'w45-a1')).toBeUndefined();
    expect(latestCandidate(state)).toBeUndefined();
  });

  it('no aplica encima de cambios sin guardar ni un parche que ya no encaja', async () => {
    const dirty = setup();
    writeFileSync(join(dirty.repo, 'saludo.ts'), 'mío\n');
    const c1 = findCandidate(dirty.state, 'w45-a1') as NonNullable<
      ReturnType<typeof findCandidate>
    >;
    const r1 = await applyCandidate(c1, gitIn(dirty.repo));
    expect(r1.ok).toBe(false);
    expect(r1.text).toContain('cambios sin guardar');
    expect(readFileSync(join(dirty.repo, 'saludo.ts'), 'utf8')).toBe('mío\n');

    const moved = setup();
    writeFileSync(join(moved.repo, 'saludo.ts'), "export const hola = 'buenas';\n");
    sh(moved.repo, 'commit', '-q', '-am', 'otro cambio');
    const c2 = findCandidate(moved.state, 'w45-a1') as NonNullable<
      ReturnType<typeof findCandidate>
    >;
    const r2 = await applyCandidate(c2, gitIn(moved.repo));
    expect(r2.ok).toBe(false);
    expect(r2.text).toContain('ya no encaja');
    expect(sh(moved.repo, 'log', '-1', '--format=%s').trim()).toBe('otro cambio');
  });

  it('«🗑 Descartar» no toca la copia y borra la rama de prueba', async () => {
    const { repo, state, patchFile } = setup();
    const wt = join(repo, '..', 'sandbox');
    sh(repo, 'worktree', 'add', '-q', '-b', 'evolve/w45-a1', wt);
    const c = candidateFromReport(state, report(patchFile));
    const r = await discardCandidate(c as NonNullable<typeof c>, gitIn(repo));
    expect(r.text).toContain('Descartado');
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, 'branch', '--list', 'evolve/w45-a1').trim()).toBe('');
    expect(readFileSync(join(repo, 'saludo.ts'), 'utf8')).toBe("export const hola = 'hola';\n");
    expect(findCandidate(state, 'w45-a1')).toBeUndefined();
  });

  it('«📄 Ver parche» enseña el diff entero sin romper el bloque de código', () => {
    const { state, patch } = setup();
    const c = findCandidate(state, 'w45-a1') as NonNullable<ReturnType<typeof findCandidate>>;
    const text = fullPatchText(c, `${patch}+const x = '${'`'.repeat(3)}';\n`);
    expect(text.startsWith('Parche del candidato w45-a1:\n```diff\n')).toBe(true);
    expect(text.match(/```/g)).toHaveLength(2);
    expect(patchStats(patch)).toEqual([{ path: 'saludo.ts', added: 2, removed: 1 }]);
    expect(reviewCard(c, patch)).not.toContain('Verificación:');
  });

  it('la orden /evolucion entiende revisar / parche / aplicar / descartar y avisa tras el ciclo', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain('(revisar|parche|aplicar|descartar)');
    expect(src).toContain('candidateFromReport(paths.state, out.report)');
    expect(src).toContain("(action === 'aplicar' || action === 'descartar') &&");
  });
});

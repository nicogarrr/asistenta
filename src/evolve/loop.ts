import { join } from 'node:path';
import { Archive, isoWeek } from './archive.js';
import { measure } from './measure.js';
import { comparable, judge, touchesForbidden } from './score.js';
import {
  changedFiles,
  createSandbox,
  dropSandbox,
  headCommit,
  isClean,
  repoRoot,
  type Sandbox,
} from './worktree.js';

/**
 * The weekly self-improvement cycle.
 *
 * The shape is the Darwin Godel Machine's: keep an archive of every attempt, propose a
 * change in an isolated checkout, measure it against the kernel it came from, and keep it
 * only if it measurably beats the kernel. Everything else here is plumbing for that.
 *
 * Three properties are deliberate and are what keep a loop from becoming a liability:
 *
 * - The kernel is never edited in place. A change reaches it by being promoted, and a
 *   promoted change is a normal commit the user can read, revert and understand.
 * - A hypothesis gets a bounded number of tries. When it runs out, the week moves on and
 *   the idea is written down as a dead end, so the loop never spends forever on one idea
 *   and never forgets it already failed.
 * - The loop cannot widen its own permissions. Forbidden files are refused before
 *   anything is measured, because a change that removes the gate is not an improvement
 *   however well it scores.
 */

export interface EvolveOptions {
  root?: string;
  stateDir: string;
  /** How many attempts one hypothesis gets before the week gives up on it. */
  maxTries?: number;
  /** Improvement, in percent, needed to reach the kernel. */
  minGainPct?: number;
  /**
   * Writes the proposed change into the sandbox and returns what it did. Injected so the
   * loop can be exercised without a model, and so the model call is the only thing that
   * needs credentials.
   */
  propose: (sandboxDir: string, hypothesis: string, attempt: number) => Promise<void>;
  /** Where the improvement comes from. Recorded, not trusted. */
  hypotheses?: () => Promise<string[]>;
  log?: (msg: string) => void;
}

export interface WeekReport {
  week: string;
  kernel: string;
  baseline: Awaited<ReturnType<typeof measure>>;
  attempts: Array<{
    hypothesis: string;
    try: number;
    verdict: string;
    delta: number;
    reason: string;
  }>;
  promoted: boolean;
}

export async function runWeek(opts: EvolveOptions): Promise<WeekReport> {
  const root = opts.root ?? repoRoot();
  const maxTries = opts.maxTries ?? 3;
  const minGainPct = opts.minGainPct ?? 1;
  const say = opts.log ?? (() => {});
  const week = isoWeek();
  const archive = new Archive(join(opts.stateDir, 'evolve', 'attempts.jsonl'));

  // A dirty tree is not a baseline: the "before" number would describe uncommitted work
  // that the candidate does not contain, and every comparison after it would be wrong.
  if (!isClean(root)) {
    say('El árbol tiene cambios sin commitear; no hay una base limpia que medir.');
    throw new Error('árbol sucio: commit o descarta los cambios antes de la evolución');
  }

  const kernel = headCommit(root);
  say(`Kernel ${kernel.slice(0, 8)}. Midiendo la base...`);
  const baseline = await measure({ cwd: root });
  if (!comparable(baseline, baseline)) {
    throw new Error(`la medición base no es válida: ${baseline.error ?? 'sin resultados'}`);
  }
  say(`Base: ${baseline.passed} tests, ${baseline.checks} checks.`);

  // Never retry what already failed, and prefer what has not been tried at all.
  const dead = new Set(archive.deadEnds());
  const ideas = ((await opts.hypotheses?.()) ?? []).filter((h) => !dead.has(h));

  const report: WeekReport = {
    week,
    kernel,
    baseline,
    attempts: [],
    promoted: false,
  };

  for (const hypothesis of ideas) {
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const id = archive.nextId();
      archive.add({ week, kind: 'hypothesis', hypothesis, tries: attempt });

      let sandbox: Sandbox;
      try {
        sandbox = createSandbox(root, kernel, id, join(opts.stateDir, 'evolve', `w${id}`));
      } catch (err) {
        say(`No se pudo aislar el intento: ${(err as Error).message}`);
        break;
      }

      try {
        await opts.propose(sandbox.dir, hypothesis, attempt);

        const touched = changedFiles(root, kernel, sandbox.branch);
        const forbidden = touchesForbidden(touched);
        if (forbidden.length) {
          const reason = `el intento toca ficheros que el bucle no puede tocar: ${forbidden.join(', ')}`;
          archive.add({
            week,
            kind: 'verdict',
            hypothesis,
            verdict: 'discard',
            reason,
            kernel,
            candidate: sandbox.branch,
            tries: attempt,
          });
          report.attempts.push({ hypothesis, try: attempt, verdict: 'discard', delta: 0, reason });
          say(reason);
          break;
        }

        const candidate = await measure({ cwd: sandbox.dir });
        const verdict = judge(baseline, candidate, { minGainPct });
        archive.add({
          week,
          kind: 'verdict',
          hypothesis,
          verdict: verdict.kind,
          reason: verdict.reason,
          kernel,
          candidate: sandbox.branch,
          measured: {
            passed: candidate.passed,
            failed: candidate.failed,
            checks: candidate.checks,
            checksFailed: candidate.checksFailed,
          },
          tries: attempt,
        });
        report.attempts.push({
          hypothesis,
          try: attempt,
          verdict: verdict.kind,
          delta: verdict.delta,
          reason: verdict.reason,
        });
        say(`${hypothesis} (intento ${attempt}): ${verdict.kind} — ${verdict.reason}`);

        if (verdict.kind === 'promote') {
          // Merged as a normal commit on the real branch. The sandbox is kept so the diff
          // can be inspected afterwards; the worktree is removed on the next run.
          const { execFileSync } = await import('node:child_process');
          execFileSync(
            'git',
            ['merge', '--no-ff', '-m', `evolucion: ${hypothesis}`, sandbox.branch],
            {
              cwd: root,
              stdio: 'inherit',
              windowsHide: true,
            },
          );
          report.promoted = true;
          say('Promovido al kernel.');
          break;
        }
        if (verdict.kind === 'discard') break;
        // retry: the idea is worth another attempt with the same hypothesis, so the
        // model is asked again with the attempt number to change its approach.
      } finally {
        if (!report.promoted) dropSandbox(root, sandbox);
      }
      if (report.promoted) break;
    }
    if (report.promoted) break;
  }

  return report;
}

/** A one-line summary for the chat, written so it cannot overstate what happened. */
export function summarize(report: WeekReport): string {
  const head = `Evolución ${report.week}: base ${report.baseline.passed} tests / ${report.baseline.checks} checks.`;
  if (!report.attempts.length) return `${head} No había hipótesis nuevas que probar.`;
  const lines = report.attempts.map(
    (a) =>
      `- ${a.hypothesis} (intento ${a.try}): ${a.verdict}, ${a.delta >= 0 ? '+' : ''}${a.delta}. ${a.reason}`,
  );
  const tail = report.promoted
    ? 'Algo entró en el kernel: revisa el commit antes de la próxima semana.'
    : 'Nada entró en el kernel esta semana.';
  return [head, ...lines, tail].join('\n');
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Archive, isoWeek } from './archive.js';
import {
  type BatteryGate,
  type BatteryRun,
  batteryVerdict,
  measureBattery,
} from './battery-gate.js';
import { checkPatch } from './guard.js';
import { measure as realMeasure } from './measure.js';
import { checklistPasses, renderReceipt, verificationChecklist } from './receipt.js';
import { comparable, judge, touchesForbidden } from './score.js';
import {
  changedFiles,
  commitAll,
  createSandbox,
  diffText,
  dropSandbox,
  headCommit,
  ignoredFiles,
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
  /** Injected so the loop can run in tests without a real suite. */
  measure?: typeof realMeasure;
  /**
   * La batería de comportamiento (selfimprove/battery.json). Un candidato solo se promueve
   * si la aprueba sin regresiones; sin batería no se promueve nada (falla cerrado).
   */
  battery?: BatteryGate;
}

export interface WeekReport {
  week: string;
  kernel: string;
  baseline: Awaited<ReturnType<typeof realMeasure>>;
  /** Nota de la batería en el kernel, si se midió. */
  batteryBaseline?: BatteryRun['score'];
  attempts: Array<{
    hypothesis: string;
    try: number;
    verdict: string;
    delta: number;
    reason: string;
  }>;
  promoted: boolean;
  /** Branch and patch of the promoted attempt: the material for a normal PR. */
  branch?: string;
  patchFile?: string;
  /** Receipt de verificación (checklist) escrito junto al parche promovido. */
  receiptFile?: string;
}

export async function runWeek(opts: EvolveOptions): Promise<WeekReport> {
  const root = opts.root ?? repoRoot();
  const maxTries = opts.maxTries ?? 3;
  const minGainPct = opts.minGainPct ?? 5;
  const say = opts.log ?? (() => {});
  const measure = opts.measure ?? realMeasure;
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
  let batteryBase: BatteryRun | undefined;
  if (opts.battery) {
    batteryBase = await measureBattery(opts.battery, root);
    say(`Batería base: ${batteryBase.score.passed}/${batteryBase.score.total} casos.`);
  }

  // Never retry what already failed, and prefer what has not been tried at all.
  const dead = new Set(archive.deadEnds());
  const ideas = ((await opts.hypotheses?.()) ?? []).filter((h) => !dead.has(h));

  const report: WeekReport = {
    week,
    kernel,
    baseline,
    batteryBaseline: batteryBase?.score,
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

        // What is checked is what is measured: commit the working tree first.
        commitAll(sandbox.dir, `evolve: ${hypothesis.slice(0, 60)}`);
        const touched = changedFiles(root, kernel, sandbox.branch);
        const patch = diffText(root, kernel, sandbox.branch);
        const forbidden = [
          ...touchesForbidden(touched),
          ...checkPatch(patch).map((v) => `${v.file} (${v.rule})`),
          ...ignoredFiles(sandbox.dir).map((f) => `${f} (fichero ignorado por git)`),
        ];
        if (!touched.length) {
          const reason = 'el intento no cambió nada';
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
        if (forbidden.length) {
          const reason = `el intento toca ficheros o reglas que el bucle no puede tocar: ${forbidden.join(', ')}`;
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
        let verdict = judge(baseline, candidate, { minGainPct });
        // «Listo» sin prueba verificable no cuenta: un promote solo sale con la
        // checklist completa, y la checklist queda escrita como receipt.
        const receiptInput = {
          week,
          hypothesis,
          attempt,
          kernel,
          branch: sandbox.branch,
          touched,
          forbidden,
          baseline,
          candidate,
          verdictReason: verdict.reason,
          delta: verdict.delta,
          minGainPct,
        };
        const checklist = verificationChecklist(receiptInput);
        if (verdict.kind === 'promote' && !checklistPasses(checklist)) {
          const missing = checklist
            .filter((it) => !it.ok)
            .map((it) => it.label)
            .join('; ');
          verdict = {
            kind: 'discard',
            delta: verdict.delta,
            reason: `checklist de verificación incompleta (${missing})`,
          };
        }
        // Los tests dicen si el código mejora; la batería, si el asistente sigue portándose
        // bien. Solo se corre cuando tests y checklist ya aprobarían (cuesta llamadas al modelo).
        let batteryAfter: BatteryRun | undefined;
        if (verdict.kind === 'promote') {
          if (!opts.battery || !batteryBase) {
            verdict = {
              kind: 'discard',
              delta: verdict.delta,
              reason: 'sin batería de evaluación: ningún cambio se promueve sin aprobarla',
            };
          } else {
            batteryAfter = await measureBattery(opts.battery, sandbox.dir);
            const bv = batteryVerdict(batteryBase, batteryAfter);
            verdict = bv.ok
              ? { ...verdict, reason: `${verdict.reason}; ${bv.reason}` }
              : { kind: 'discard', delta: verdict.delta, reason: bv.reason };
          }
        }
        receiptInput.verdictReason = verdict.reason;
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
          battery:
            batteryAfter && batteryBase
              ? {
                  passed: batteryAfter.score.passed,
                  total: batteryAfter.score.total,
                  basePassed: batteryBase.score.passed,
                  baseTotal: batteryBase.score.total,
                }
              : undefined,
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
          // Never merged here. A promoted attempt leaves a branch and a patch, and goes to
          // the repo as a normal PR that is audited like any other change.
          const dir = join(opts.stateDir, 'evolve');
          mkdirSync(dir, { recursive: true });
          const patchFile = join(dir, `promovido-${id}.patch`);
          writeFileSync(patchFile, patch, 'utf8');
          const receiptFile = join(dir, `promovido-${id}.receipt.md`);
          writeFileSync(receiptFile, renderReceipt(receiptInput, checklist), 'utf8');
          report.branch = sandbox.branch;
          report.patchFile = patchFile;
          report.receiptFile = receiptFile;
          report.promoted = true;
          say(
            `Candidato listo: rama ${sandbox.branch}, parche ${patchFile}, receipt ${receiptFile}. Va como PR con auditoría; no se ha mergeado nada.`,
          );
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
  const bat = report.batteryBaseline
    ? ` Batería ${report.batteryBaseline.passed}/${report.batteryBaseline.total}.`
    : '';
  const head = `Evolución ${report.week}: base ${report.baseline.passed} tests / ${report.baseline.checks} checks.${bat}`;
  if (!report.attempts.length) return `${head} No había hipótesis nuevas que probar.`;
  const lines = report.attempts.map(
    (a) =>
      `- ${a.hypothesis} (intento ${a.try}): ${a.verdict}, ${a.delta >= 0 ? '+' : ''}${a.delta}. ${a.reason}`,
  );
  const tail = report.promoted
    ? `Hay un candidato (rama ${report.branch ?? '?'}) con su receipt de verificación: sale como PR y no entra sin auditoría.`
    : 'Ningún candidato pasó la regla esta semana.';
  return [head, ...lines, tail].join('\n');
}

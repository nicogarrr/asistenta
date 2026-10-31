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
import { reapAttempt } from './reap.js';
import { checklistPasses, renderReceipt, verificationChecklist } from './receipt.js';
import { comparable, judge, touchesForbidden } from './score.js';
import {
  changedFiles,
  commitAll,
  createSandbox,
  depsFingerprint,
  diffText,
  dropSandbox,
  gitControlFingerprint,
  headCommit,
  ignoredFiles,
  isClean,
  repoRoot,
  type Sandbox,
  sandboxGitFingerprint,
  treeDirFingerprint,
  treeStatFingerprint,
  watchRoot,
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
   * La batería de comportamiento (evolve/battery.json). Un candidato solo se promueve
   * si la aprueba sin regresiones; sin batería no se promueve nada (falla cerrado).
   */
  battery?: BatteryGate;
  /** Cierra los procesos que el intento dejó en marcha (reap.ts). Inyectado en tests. */
  reap?: (sandboxDir: string) => number;
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
  const reap = opts.reap ?? reapAttempt;
  // Lo que el proponente o el código del intento dejan vivo podría cambiar la copia mientras
  // se mide, o después: se cierra antes de revisar, después de medir y al tirar la copia.
  const reapNow = (dir: string, when: string): void => {
    const n = reap(dir);
    if (n > 0) say(`se cerraron ${n} procesos que el intento dejó en marcha (${when})`);
    if (n < 0) say(`no se pudieron listar los procesos del intento (${when})`);
  };
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
    try {
      opts.battery.onBase?.(batteryBase);
    } catch {
      // El historial es una ayuda: si no se puede escribir, el ciclo sigue igual.
    }
    say(`Batería base: ${batteryBase.score.passed}/${batteryBase.score.total} casos.`);
  }

  // Never retry what already failed, and prefer what has not been tried at all.
  const dead = new Set(archive.deadEnds());
  // Sin repetidas: la misma idea apuntada dos veces se probaba dos veces la misma semana
  // (otra medición entera y otra batería con el modelo) aunque la primera ya la descartara.
  const ideas = [...new Set((await opts.hypotheses?.()) ?? [])].filter((h) => !dead.has(h));

  const report: WeekReport = {
    week,
    kernel,
    baseline,
    batteryBaseline: batteryBase?.score,
    attempts: [],
    promoted: false,
  };

  let proposerDown = false;
  for (const hypothesis of ideas) {
    if (proposerDown) break;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const id = archive.nextId();
      archive.add({ week, kind: 'hypothesis', hypothesis, tries: attempt });

      let sandbox: Sandbox;
      let stopRootWatch: (() => Promise<string[]>) | undefined;
      try {
        sandbox = createSandbox(root, kernel, id, join(opts.stateDir, 'evolve', `w${id}`));
      } catch (err) {
        // Sin aislamiento no se mide nada: es fallo de la máquina, no de la idea. Queda
        // archivado con veredicto (sin medir) y la semana para aquí, como con el proponente.
        const reason = `no se pudo aislar el intento: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
        archive.add({
          week,
          kind: 'verdict',
          hypothesis,
          verdict: 'discard',
          reason,
          unmeasured: true,
          kernel,
          tries: attempt,
        });
        report.attempts.push({ hypothesis, try: attempt, verdict: 'discard', delta: 0, reason });
        say(reason);
        proposerDown = true;
        break;
      }

      // Lo que el intento haga en su node_modules no entra en el diff: se compara la huella.
      const depsBefore = depsFingerprint(sandbox.dir);
      const gitBefore = gitControlFingerprint(root);
      const sandboxGitBefore = sandboxGitFingerprint(sandbox.dir);
      try {
        try {
          await opts.propose(sandbox.dir, hypothesis, attempt);
          reapNow(sandbox.dir, 'tras el proponente');
        } catch (err) {
          reapNow(sandbox.dir, 'tras el proponente');
          // Un fallo del proponente (modelo caído, sin clave...) es de la máquina, no de la
          // idea: queda archivado con veredicto y la semana para aquí, sin tumbar el ciclo.
          const reason = `el proponente falló: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
          archive.add({
            week,
            kind: 'verdict',
            hypothesis,
            verdict: 'discard',
            reason,
            unmeasured: true,
            kernel,
            candidate: sandbox.branch,
            tries: attempt,
          });
          report.attempts.push({ hypothesis, try: attempt, verdict: 'discard', delta: 0, reason });
          say(reason);
          proposerDown = true;
          break;
        }

        // El proponente es un programa cualquiera: nada le impide escribir fuera de su sandbox,
        // en el árbol del kernel, o mover su rama desde el worktree (las ramas se comparten).
        // Eso no pasa por el guard ni por la medición: se descarta y la semana para aquí,
        // sin tocar lo que haya cambiado, para que una persona lo mire.
        // Primero los hooks y la config de git (se leen sin git): si cambiaron, ni un git status.
        // Y el git del propio intento: el commit de abajo se hace con él.
        const gitChanged = gitControlFingerprint(root) !== gitBefore;
        const sandboxGitChanged = sandboxGitFingerprint(sandbox.dir) !== sandboxGitBefore;
        if (gitChanged || sandboxGitChanged || !isClean(root) || headCommit(root) !== kernel) {
          const reason = gitChanged
            ? 'el proponente cambió la config o los hooks de git del kernel: no se mide ni se promueve; revisa .git a mano'
            : sandboxGitChanged
              ? 'el proponente redirigió el git del intento (su .git o su HEAD): no se mide ni se promueve; revisa a mano'
              : 'el proponente cambió el árbol del kernel fuera de su sandbox: no se mide ni se promueve; revisa los cambios a mano';
          archive.add({
            week,
            kind: 'verdict',
            hypothesis,
            verdict: 'discard',
            reason,
            unmeasured: true,
            kernel,
            candidate: sandbox.branch,
            tries: attempt,
          });
          report.attempts.push({ hypothesis, try: attempt, verdict: 'discard', delta: 0, reason });
          say(reason);
          proposerDown = true;
          break;
        }

        // What is checked is what is measured: commit the working tree first.
        commitAll(sandbox.dir, `evolve: ${hypothesis.slice(0, 60)}`);
        const checkedHead = headCommit(sandbox.dir);
        const checkedTree = treeStatFingerprint(sandbox.dir);
        const checkedDirs = treeDirFingerprint(sandbox.dir);
        stopRootWatch = watchRoot(sandbox.dir);
        const touched = changedFiles(root, kernel, sandbox.branch);
        const patch = diffText(root, kernel, sandbox.branch);
        const forbidden = [
          ...touchesForbidden(touched),
          ...checkPatch(patch).map((v) => `${v.file} (${v.rule})`),
          ...ignoredFiles(sandbox.dir).map((f) => `${f} (fichero ignorado por git)`),
          ...(depsFingerprint(sandbox.dir) !== depsBefore
            ? ['node_modules (el intento cambió las dependencias)']
            : []),
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
        // A discard that never measured the idea (no comparable number, no per-test report)
        // is about the machine, not the idea: it is archived as such so it is not a dead end.
        let unmeasured =
          verdict.kind === 'discard' &&
          (!comparable(baseline, candidate) || !baseline.passingTests || !candidate.passingTests);
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
            unmeasured = true;
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
        reapNow(sandbox.dir, 'tras medir');
        // Lo medido tiene que ser lo revisado. Un proceso que el proponente dejó vivo, o el propio
        // código del intento durante sus tests, puede cambiar la copia después del guard (un test,
        // la config, node_modules o su git): los números serían de otro árbol que el parche.
        const rootNames = await stopRootWatch();
        if (
          rootNames.length > 0 ||
          headCommit(sandbox.dir) !== checkedHead ||
          !isClean(sandbox.dir) ||
          treeStatFingerprint(sandbox.dir) !== checkedTree ||
          treeDirFingerprint(sandbox.dir) !== checkedDirs ||
          depsFingerprint(sandbox.dir) !== depsBefore ||
          sandboxGitFingerprint(sandbox.dir) !== sandboxGitBefore
        ) {
          unmeasured = true;
          proposerDown = true;
          verdict = {
            kind: 'discard',
            delta: verdict.delta,
            reason: `la copia del intento cambió después de revisarla (ficheros, dependencias o git${rootNames.length ? `; en la raíz: ${rootNames.slice(0, 3).join(', ')}` : ''}): lo medido no es el parche; no se promueve`,
          };
        }
        // Medir también ejecuta código del intento (sus tests, la batería): el kernel tiene que
        // seguir igual después. Primero la huella de .git, que se lee sin llamar a git.
        if (
          gitControlFingerprint(root) !== gitBefore ||
          !isClean(root) ||
          headCommit(root) !== kernel
        ) {
          unmeasured = true;
          proposerDown = true;
          verdict = {
            kind: 'discard',
            delta: verdict.delta,
            reason:
              'medir el intento cambió el árbol, la config o los hooks del kernel: no se promueve; revisa los cambios a mano',
          };
        }
        receiptInput.verdictReason = verdict.reason;
        archive.add({
          week,
          kind: 'verdict',
          hypothesis,
          verdict: verdict.kind,
          reason: verdict.reason,
          ...(unmeasured ? { unmeasured: true } : {}),
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
        await stopRootWatch?.();
        reapNow(sandbox.dir, 'al cerrar el intento');
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

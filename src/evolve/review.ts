import { execFile } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandButton } from '../channels/telegram-shared.js';
import { sliceSafe } from '../text.js';
import type { WeekReport } from './loop.js';

/**
 * «Revisar antes de aplicar» para la auto-mejora.
 *
 * Un ciclo que promueve un candidato deja un parche en `<estado>/evolve/promovido-<id>.patch`
 * y hasta ahora solo lo decía en una línea («Hay un candidato (rama …)»): para verlo o
 * aplicarlo había que ir al PC. Ahora llega a Telegram una ficha con qué cambia (ficheros,
 * líneas añadidas y quitadas, un trozo del diff y la verificación) y tres botones:
 * «📄 Ver parche», «✅ Aplicar» y «🗑 Descartar». Nada se aplica sin ese toque del dueño.
 *
 * Aplicar es reversible. Si en el PC está `gh` con sesión iniciada, el parche va a una rama
 * `auto-mejora/<id>` en GitHub y se abre una PR: la copia instalada no se toca y la
 * actualización automática sigue trayendo main (cuando el dueño fusione la PR, llega sola).
 * Sin `gh` (o si la subida falla) el parche entra como UN commit local en la copia instalada
 * («Auto-mejora: …»). En ambos casos solo si no hay cambios locales sin guardar y si el
 * parche encaja con el código de ahora. El commit local se deshace con `git revert <commit>`.
 */

/** Id del candidato tal como va en el nombre del parche y en el botón. */
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PATCH_RE = /^promovido-([A-Za-z0-9_-]{1,40})\.patch$/;
const PREVIEW_LINES = 30;
const FULL_PATCH_MAX = 12_000;

export interface PromotedCandidate {
  id: string;
  patchFile: string;
  receiptFile?: string;
  hypothesis?: string;
  branch?: string;
}

function evolveDir(stateDir: string): string {
  return join(stateDir, 'evolve');
}

/** El id de un parche promovido a partir de su ruta, o undefined si no tiene esa forma. */
export function candidateId(patchFile: string): string | undefined {
  const base = patchFile.split(/[\\/]/).pop() ?? '';
  return PATCH_RE.exec(base)?.[1];
}

/** Guarda la hipótesis y la rama del candidato (el parche no las lleva). */
export function saveCandidateMeta(
  stateDir: string,
  c: { id: string; hypothesis?: string; branch?: string },
): void {
  if (!ID_RE.test(c.id)) return;
  writeFileSync(
    join(evolveDir(stateDir), `promovido-${c.id}.json`),
    JSON.stringify({ hypothesis: c.hypothesis, branch: c.branch }),
    'utf8',
  );
}

/** El candidato pendiente con ese id (sin aplicar ni descartar), o undefined. */
export function findCandidate(stateDir: string, id: string): PromotedCandidate | undefined {
  if (!ID_RE.test(id)) return undefined;
  const dir = evolveDir(stateDir);
  const patchFile = join(dir, `promovido-${id}.patch`);
  if (!existsSync(patchFile)) return undefined;
  const receiptFile = join(dir, `promovido-${id}.receipt.md`);
  let meta: { hypothesis?: unknown; branch?: unknown } = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, `promovido-${id}.json`), 'utf8'));
  } catch {
    // Sin ficha: se revisa igual, solo sin el título de la idea.
  }
  return {
    id,
    patchFile,
    receiptFile: existsSync(receiptFile) ? receiptFile : undefined,
    hypothesis: typeof meta.hypothesis === 'string' ? meta.hypothesis : undefined,
    branch: typeof meta.branch === 'string' ? meta.branch : undefined,
  };
}

/** El candidato pendiente más reciente, o undefined si no hay ninguno. */
export function latestCandidate(stateDir: string): PromotedCandidate | undefined {
  const dir = evolveDir(stateDir);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const ids = names
    .map((n) => PATCH_RE.exec(n)?.[1])
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, at: statSync(join(dir, `promovido-${id}.patch`)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return ids[0] ? findCandidate(stateDir, ids[0].id) : undefined;
}

export interface PatchFileStat {
  path: string;
  added: number;
  removed: number;
}

/** Ficheros del parche con sus líneas añadidas y quitadas, en orden. */
export function patchStats(patch: string): PatchFileStat[] {
  const files: PatchFileStat[] = [];
  let cur: PatchFileStat | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2] as string, added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  return files;
}

/** Un bloque ``` dentro del diff cerraría el bloque de la ficha: se cambia por '''. */
function fenceSafe(s: string): string {
  return s.replace(/```/g, "'''");
}

/** Las primeras líneas de cambio del diff (sin cabeceras de git), para la ficha. */
function diffPreview(patch: string): { text: string; more: boolean } {
  const body = patch
    .split(/\r?\n/)
    .filter((l) => !/^(diff --git|index |new file mode|deleted file mode|similarity )/.test(l));
  while (body.length && !body[body.length - 1]?.trim()) body.pop();
  const shown = body.slice(0, PREVIEW_LINES).map(fenceSafe);
  return { text: shown.join('\n').trimEnd(), more: body.length > PREVIEW_LINES };
}

/** Los puntos de la verificación (receipt) en una línea cada uno, si los hay. */
function receiptLines(receipt: string): string[] {
  return receipt
    .split(/\r?\n/)
    .filter((l) => /^\s*[-*]\s*\[[ xX]\]/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^[-*]\s*\[[xX]\]\s*/, '✅ ')
        .replace(/^[-*]\s*\[ \]\s*/, '⬜ '),
    )
    .slice(0, 8);
}

/** La ficha de revisión que llega a Telegram con los botones. */
export function reviewCard(c: PromotedCandidate, patch: string, receipt = ''): string {
  const stats = patchStats(patch);
  const added = stats.reduce((n, f) => n + f.added, 0);
  const removed = stats.reduce((n, f) => n + f.removed, 0);
  const lines = ['🧪 La auto-mejora tiene un cambio candidato. Revísalo antes de aplicarlo:'];
  if (c.hypothesis) lines.push(`Idea: ${c.hypothesis}`);
  lines.push(
    `Cambia ${stats.length} ${stats.length === 1 ? 'fichero' : 'ficheros'} (+${added} −${removed}):`,
    ...stats.slice(0, 10).map((f) => `• ${f.path} (+${f.added} −${f.removed})`),
  );
  if (stats.length > 10) lines.push(`• … y ${stats.length - 10} más`);
  const checks = receiptLines(receipt);
  if (checks.length) lines.push('', 'Verificación:', ...checks);
  const preview = diffPreview(patch);
  if (preview.text) {
    lines.push('', '```diff', preview.text, '```');
    if (preview.more) lines.push('(sigue; «📄 Ver parche» lo enseña entero)');
  }
  lines.push(
    '',
    'Nada se aplica sin tu toque. «✅ Aplicar» abre una PR en GitHub si tienes gh con sesión en el PC; si no, lo guarda como un commit en tu copia (se deshace con git revert).',
  );
  return lines.join('\n');
}

/** Los tres botones de la ficha (cada uno equivale a teclear `/evolucion <acción> <id>`). */
export function reviewButtons(id: string): Array<{ label: string; action: string }> {
  return [
    commandButton('📄 Ver parche', 'evolucion', id, 'parche'),
    commandButton('✅ Aplicar', 'evolucion', id, 'aplicar'),
    commandButton('🗑 Descartar', 'evolucion', id, 'descartar'),
  ].filter((b): b is { label: string; action: string } => Boolean(b));
}

/** El parche entero para el chat, acotado. */
export function fullPatchText(c: PromotedCandidate, patch: string): string {
  const cut = patch.length > FULL_PATCH_MAX;
  const body = fenceSafe(cut ? patch.slice(0, FULL_PATCH_MAX) : patch).trimEnd();
  const lines = [`Parche del candidato ${c.id}:`, '```diff', body, '```'];
  if (cut) lines.push(`(cortado; el parche entero está en ${c.patchFile})`);
  return lines.join('\n');
}

export type GitRunner = (args: string[]) => Promise<{ code: number; out: string }>;

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${sliceSafe(t, max - 1)}…` : t;
}

/** Rama de GitHub para la PR de un candidato. */
export function prBranch(c: PromotedCandidate): string {
  return `auto-mejora/${c.id}`;
}

function markPatch(c: PromotedCandidate, suffix: string): void {
  try {
    renameSync(c.patchFile, c.patchFile.replace(/\.patch$/, `.${suffix}.patch`));
  } catch {
    // Si no se pudo renombrar, un segundo toque lo rechaza `git apply --check`.
  }
}

function prBody(c: PromotedCandidate): string {
  const lines = [
    `Propuesta por la auto-mejora de Asistenta (candidato ${c.id}), aprobada desde Telegram con «✅ Aplicar».`,
  ];
  if (c.hypothesis) lines.push('', `Idea: ${c.hypothesis}`);
  let receipt = '';
  try {
    if (c.receiptFile && existsSync(c.receiptFile)) receipt = readFileSync(c.receiptFile, 'utf8');
  } catch {
    receipt = '';
  }
  const checks = receiptLines(receipt);
  if (checks.length) lines.push('', 'Verificación:', ...checks);
  return lines.join('\n');
}

type PrOutcome =
  | { kind: 'skip' }
  | { kind: 'pr'; text: string }
  | { kind: 'pushed'; text: string }
  | { kind: 'failed'; why: string };

/**
 * Sube el candidato a una rama `auto-mejora/<id>` y abre una PR con `gh`, sin tocar la copia
 * instalada (se hace en una copia de trabajo temporal de git). `skip` si no hay `gh` con
 * sesión o la copia no está en una rama; `failed` si algo falla antes de subir la rama.
 */
async function openPullRequest(
  c: PromotedCandidate,
  title: string,
  git: GitRunner,
  gh: GitRunner,
): Promise<PrOutcome> {
  const auth = await gh(['auth', 'status']);
  if (auth.code !== 0) return { kind: 'skip' };
  const base = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  if (!base || base === 'HEAD' || !/^[A-Za-z0-9._/-]{1,120}$/.test(base)) return { kind: 'skip' };
  const branch = prBranch(c);
  const dir = join(tmpdir(), `asistenta-automejora-${c.id}-${Date.now()}`);
  await git(['branch', '-D', branch]);
  const add = await git(['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
  if (add.code !== 0) return { kind: 'failed', why: oneLine(add.out) };
  try {
    const apply = await git(['-C', dir, 'apply', '--index', c.patchFile]);
    if (apply.code !== 0) return { kind: 'failed', why: oneLine(apply.out) };
    const commit = await git(['-C', dir, 'commit', '--quiet', '--no-verify', '-m', title]);
    if (commit.code !== 0) return { kind: 'failed', why: oneLine(commit.out) };
    // Credenciales de GitHub las da `gh` (ya con sesión), sin depender de `gh auth setup-git`.
    const push = await git([
      '-C',
      dir,
      '-c',
      'credential.https://github.com.helper=',
      '-c',
      'credential.https://github.com.helper=!gh auth git-credential',
      'push',
      '--quiet',
      'origin',
      `HEAD:refs/heads/${branch}`,
    ]);
    if (push.code !== 0) return { kind: 'failed', why: oneLine(push.out) };
  } finally {
    await git(['worktree', 'remove', '--force', dir]);
    await git(['branch', '-D', branch]);
  }
  const pr = await gh([
    'pr',
    'create',
    '--base',
    base,
    '--head',
    branch,
    '--title',
    title,
    '--body',
    prBody(c),
  ]);
  const url = /https:\/\/\S+\/pull\/\d+/.exec(pr.out)?.[0];
  if (pr.code === 0 && url)
    return {
      kind: 'pr',
      text: [
        `✅ Abierta la PR en GitHub: ${url}`,
        `(«${title}», rama ${branch} sobre ${base}). Tu copia no se ha tocado.`,
        'Cuando la fusiones, la actualización automática la trae sola. Si no te convence, ciérrala.',
      ].join('\n'),
    };
  return {
    kind: 'pushed',
    text: [
      `Subí el cambio a la rama ${branch} en GitHub, pero no pude abrir la PR (${oneLine(pr.out)}).`,
      `Ábrela tú desde GitHub (rama ${branch} → ${base}). Tu copia no se ha tocado.`,
    ].join('\n'),
  };
}

/**
 * Aplica el candidato. Con `gh` con sesión en el PC abre una PR (la copia instalada no se
 * toca y la actualización automática sigue); si no, o si la subida falla, lo guarda como un
 * commit en la copia instalada. Se niega (sin tocar nada) si hay cambios locales sin guardar
 * o si el parche ya no encaja con el código actual.
 */
export async function applyCandidate(
  c: PromotedCandidate,
  git: GitRunner,
  gh?: GitRunner,
): Promise<{ ok: boolean; text: string }> {
  const status = await git(['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0)
    return {
      ok: false,
      text: `No lo he aplicado: no pude leer el estado de git (${oneLine(status.out)}).`,
    };
  if (status.out.trim())
    return {
      ok: false,
      text: 'No lo he aplicado: tu copia tiene cambios sin guardar y no quiero mezclarlos. Guárdalos o deshazlos y vuelve a pulsar «✅ Aplicar».',
    };
  const check = await git(['apply', '--check', c.patchFile]);
  if (check.code !== 0)
    return {
      ok: false,
      text: `No lo he aplicado: el parche ya no encaja con el código actual (cambió desde que se probó). Lanza otro ciclo con /evolucion ahora.\nDetalle: ${oneLine(check.out)}`,
    };
  const title = `Auto-mejora: ${oneLine(c.hypothesis ?? `candidato ${c.id}`, 70)}`;
  let note = '';
  if (gh) {
    const pr = await openPullRequest(c, title, git, gh);
    if (pr.kind === 'pr' || pr.kind === 'pushed') {
      markPatch(c, 'pr');
      return { ok: true, text: pr.text };
    }
    if (pr.kind === 'failed')
      note = `No pude subirlo a GitHub (${pr.why}); lo dejo como commit en tu copia.`;
  }
  const apply = await git(['apply', '--index', c.patchFile]);
  if (apply.code !== 0)
    return { ok: false, text: `No lo he aplicado: git apply falló (${oneLine(apply.out)}).` };
  const commit = await git(['commit', '--quiet', '--no-verify', '-m', title]);
  if (commit.code !== 0) {
    // Sin commit, el cambio quedaría a medias en el índice: se deja la copia como estaba.
    await git(['reset', '--quiet', '--hard', 'HEAD']);
    return {
      ok: false,
      text: `No lo he aplicado: no pude crear el commit (${oneLine(commit.out)}).`,
    };
  }
  const sha = (await git(['rev-parse', '--short', 'HEAD'])).out.trim();
  markPatch(c, 'aplicado');
  return {
    ok: true,
    text: [
      ...(note ? [note] : []),
      `✅ Aplicado como commit ${sha} («${title}»).`,
      'Se usa al reiniciar Asistenta (npm run build y reiniciar).',
      `Para deshacerlo: git revert ${sha}. La actualización automática espera hasta que subas este commit (git push) o lo deshagas.`,
    ].join('\n'),
  };
}

/** Descarta el candidato: el parche queda marcado y su copia de prueba se borra. */
export async function discardCandidate(
  c: PromotedCandidate,
  git: GitRunner,
): Promise<{ text: string }> {
  renameSync(c.patchFile, c.patchFile.replace(/\.patch$/, '.descartado.patch'));
  if (c.branch && /^[A-Za-z0-9._/-]{1,120}$/.test(c.branch)) {
    const list = await git(['worktree', 'list', '--porcelain']);
    const block = list.out
      .split(/\r?\n\r?\n/)
      .find((b) => b.split(/\r?\n/).includes(`branch refs/heads/${c.branch}`));
    const dir = block ? /^worktree (.+)$/m.exec(block)?.[1] : undefined;
    if (dir) await git(['worktree', 'remove', '--force', dir]);
    await git(['branch', '-D', c.branch]);
  }
  return { text: '🗑 Descartado. Tu copia no se ha tocado.' };
}

/** git de verdad en la copia instalada (`cwd`), sin lanzar: código de salida y salida. */
export function gitIn(cwd: string): GitRunner {
  return runnerIn('git', cwd);
}

/**
 * El CLI `gh` de GitHub en la copia instalada, sin lanzar. Si no está instalado o no tiene
 * sesión, `gh auth status` sale con error y «Aplicar» usa el commit local de siempre.
 */
export function ghIn(cwd: string): GitRunner {
  return runnerIn('gh', cwd);
}

function runnerIn(bin: string, cwd: string): GitRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          cwd,
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          // Sin consola: nunca esperar a que alguien teclee usuario/contraseña.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
        },
      );
    });
}

/**
 * El candidato que acaba de promover un ciclo, con su idea y su rama apuntadas para la
 * ficha y para «Descartar». undefined si el ciclo no promovió nada.
 */
export function candidateFromReport(
  stateDir: string,
  report: WeekReport | undefined,
): PromotedCandidate | undefined {
  if (!report?.promoted || !report.patchFile) return undefined;
  const id = candidateId(report.patchFile);
  if (!id) return undefined;
  const hypothesis = [...report.attempts]
    .reverse()
    .find((a) => a.verdict === 'promote')?.hypothesis;
  try {
    saveCandidateMeta(stateDir, { id, hypothesis, branch: report.branch });
  } catch {
    // Sin ficha guardada se revisa igual; «Descartar» no podrá borrar la rama de prueba.
  }
  return findCandidate(stateDir, id);
}

/** Ficha + botones de un candidato, leyendo su parche y su verificación del disco. */
export function reviewMessage(c: PromotedCandidate): {
  text: string;
  buttons: Array<{ label: string; action: string }>;
} {
  const patch = readFileSync(c.patchFile, 'utf8');
  let receipt = '';
  try {
    receipt = c.receiptFile ? readFileSync(c.receiptFile, 'utf8') : '';
  } catch {
    receipt = '';
  }
  return { text: reviewCard(c, patch, receipt), buttons: reviewButtons(c.id) };
}

/**
 * «Revisa este PR»: un enlace de GitHub a una pull request, un commit, una comparación
 * (`/compare/a...b`) o una issue se lee por la API pública de GitHub en vez de la página
 * (que es HTML pesado y casi todo menú). Devuelve lo que hace falta para resumir y avisar de
 * riesgos: título, autor, estado, ramas, ficheros con líneas +/−, avisos automáticos
 * (dependencias, CI, migraciones, secretos o permisos, borrados grandes, código sin tests,
 * conflictos, ficheros cuyo diff GitHub no da por grandes, listas de ficheros cortadas) y el
 * diff, acotado; de una issue, su descripción y los últimos comentarios. Solo lectura y sin
 * clave (con GITHUB_TOKEN en el entorno, también repos privados y más margen de cuota).
 */

import { sliceSafe } from '../text.js';

export interface GithubTarget {
  kind: 'pull' | 'commit' | 'compare' | 'issue';
  owner: string;
  repo: string;
  ref: string;
}

const NAME = '[A-Za-z0-9_.-]{1,100}';
const PULL_RE = new RegExp(
  `^/(${NAME})/(${NAME})/pull/(\\d{1,9})(?:/(?:files|commits|checks)?)?/?$`,
);
const COMMIT_RE = new RegExp(
  `^/(${NAME})/(${NAME})/(?:pull/\\d{1,9}/)?commits?/([0-9a-fA-F]{7,40})/?$`,
);
const COMPARE_RE = new RegExp(`^/(${NAME})/(${NAME})/compare/([A-Za-z0-9_.:/~^-]{1,250}?)/?$`);
const ISSUE_RE = new RegExp(`^/(${NAME})/(${NAME})/issues/(\\d{1,9})/?$`);

/** Nombre de lo que señala el enlace, para el modelo. */
export const GITHUB_KIND_LABEL: Record<GithubTarget['kind'], string> = {
  pull: 'pull request',
  commit: 'commit',
  compare: 'comparison',
  issue: 'issue',
};

/** La PR, el commit, la comparación o la issue de un enlace de github.com, o null si es otra cosa. */
export function parseGithubUrl(url: string): GithubTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(u.hostname) || !/^https?:$/.test(u.protocol)) return null;
  const pull = PULL_RE.exec(u.pathname);
  if (pull)
    return {
      kind: 'pull',
      owner: pull[1] as string,
      repo: pull[2] as string,
      ref: pull[3] as string,
    };
  const commit = COMMIT_RE.exec(u.pathname);
  if (commit)
    return {
      kind: 'commit',
      owner: commit[1] as string,
      repo: commit[2] as string,
      ref: commit[3] as string,
    };
  const issue = ISSUE_RE.exec(u.pathname);
  if (issue)
    return {
      kind: 'issue',
      owner: issue[1] as string,
      repo: issue[2] as string,
      ref: issue[3] as string,
    };
  const cmp = COMPARE_RE.exec(u.pathname);
  if (cmp) {
    // «a...b» como en la web; «a..b» se lee igual. Sin dos refs (p. ej. /compare/rama) no hay
    // con qué comparar: se lee la página.
    const parts = (cmp[3] as string).split(/\.{2,3}/);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return {
      kind: 'compare',
      owner: cmp[1] as string,
      repo: cmp[2] as string,
      ref: `${parts[0]}...${parts[1]}`,
    };
  }
  return null;
}

export interface ChangedFile {
  filename: string;
  status?: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const TEST_RE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const DEPS_RE =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?)$/i;
const CI_RE =
  /^\.github\/(workflows|actions)\/|(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|\.gitlab-ci\.yml)$/i;
const MIGRATION_RE = /(^|\/)(migrations?|alembic)\/|\.sql$/i;
const SENSITIVE_RE = /secret|vault|credential|token|passw|auth|permission|permiso|\.env($|\.)/i;
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php)$/i;

/** Avisos automáticos de riesgo, en español, a partir de los ficheros cambiados. */
export function riskFlags(
  files: readonly ChangedFile[],
  opts: { mergeable?: boolean | null } = {},
): string[] {
  const flags: string[] = [];
  const names = (re: RegExp) => files.filter((f) => re.test(f.filename)).map((f) => f.filename);
  const list = (xs: string[]) =>
    xs.slice(0, 4).join(', ') + (xs.length > 4 ? ` y ${xs.length - 4} más` : '');
  const deps = names(DEPS_RE);
  if (deps.length)
    flags.push(
      `Cambia dependencias (${list(deps)}): revisa qué paquetes entran o suben de versión.`,
    );
  const ci = names(CI_RE);
  if (ci.length) flags.push(`Toca CI o despliegue (${list(ci)}).`);
  const mig = names(MIGRATION_RE);
  if (mig.length)
    flags.push(`Incluye migraciones de base de datos (${list(mig)}): mira si son reversibles.`);
  const sens = names(SENSITIVE_RE);
  if (sens.length)
    flags.push(`Toca ficheros de secretos, autenticación o permisos (${list(sens)}).`);
  const removed = files.filter((f) => f.status === 'removed').map((f) => f.filename);
  if (removed.length)
    flags.push(
      `Borra ${removed.length} ${removed.length === 1 ? 'fichero' : 'ficheros'} (${list(removed)}).`,
    );
  const del = files.reduce((n, f) => n + f.deletions, 0);
  const add = files.reduce((n, f) => n + f.additions, 0);
  if (del >= 300) flags.push(`Quita muchas líneas (−${del}).`);
  if (add + del >= 1000 || files.length >= 30)
    flags.push(
      `Es grande (${files.length} ficheros, +${add} −${del}): difícil de revisar de una vez.`,
    );
  const code = files.filter((f) => CODE_RE.test(f.filename) && !TEST_RE.test(f.filename));
  if (code.length && !files.some((f) => TEST_RE.test(f.filename)))
    flags.push('Cambia código sin añadir ni tocar tests.');
  if (opts.mergeable === false)
    flags.push('GitHub dice que tiene conflictos con la rama de destino.');
  return flags;
}

export type GithubFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

async function getJson(fetchFn: GithubFetch, url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'asistenta',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404)
    throw new Error('GitHub no encuentra ese enlace (¿repo privado o borrado?)');
  if (res.status === 403 || res.status === 429)
    throw new Error(
      'GitHub ha limitado las consultas sin clave; prueba en un rato o pon GITHUB_TOKEN',
    );
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
  return res.json();
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toFiles(raw: unknown): ChangedFile[] {
  return (Array.isArray(raw) ? raw : []).map((f: Record<string, unknown>) => ({
    filename: str(f.filename),
    status: str(f.status) || undefined,
    additions: n(f.additions),
    deletions: n(f.deletions),
    patch: typeof f.patch === 'string' ? f.patch : undefined,
  }));
}

const cut = (s: string, max: number): string => (s.length > max ? `${sliceSafe(s, max)}…` : s);

/** Ficheros que cambian líneas pero vienen sin `patch`: GitHub omite el diff de los grandes. */
function omittedDiff(files: readonly ChangedFile[]): ChangedFile[] {
  return files.filter((f) => !f.patch && f.additions + f.deletions > 0);
}

/** Una issue: cabecera, descripción y los últimos comentarios (sin diff). */
async function issueText(
  fetchFn: GithubFetch,
  base: string,
  target: GithubTarget,
  issue: Record<string, unknown>,
  token: string | undefined,
  limit: number,
): Promise<string> {
  const user = (issue.user as { login?: string } | undefined)?.login ?? '?';
  const state =
    issue.state === 'closed'
      ? issue.state_reason === 'not_planned'
        ? 'cerrada (no se hará)'
        : 'cerrada (resuelta)'
      : 'abierta';
  const labels = (Array.isArray(issue.labels) ? issue.labels : [])
    .map((l: unknown) => (typeof l === 'string' ? l : str((l as { name?: unknown })?.name)))
    .filter(Boolean);
  const comments = n(issue.comments);
  const lines = [
    `Issue #${target.ref} de ${target.owner}/${target.repo}: «${str(issue.title)}»`,
    `Autor: ${user} · Estado: ${state} · ${str(issue.created_at).slice(0, 10)}${labels.length ? ` · Etiquetas: ${labels.join(', ')}` : ''} · ${comments} ${comments === 1 ? 'comentario' : 'comentarios'}`,
  ];
  const body = str(issue.body).trim();
  lines.push('', 'Descripción:', body ? cut(body, 3000) : '(vacía)');
  if (comments > 0) {
    const raw = await getJson(fetchFn, `${base}/issues/${target.ref}/comments?per_page=100`, token);
    const all = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    const last = all.slice(-15);
    lines.push(
      '',
      all.length > last.length || comments > all.length
        ? `Últimos ${last.length} comentarios (de ${Math.max(comments, all.length)}):`
        : 'Comentarios:',
      ...last.map(
        (c) =>
          `- ${(c.user as { login?: string } | undefined)?.login ?? '?'} (${str(c.created_at).slice(0, 10)}): ${cut(str(c.body).replace(/\s+/g, ' ').trim(), 500)}`,
      ),
    );
  }
  const text = lines.join('\n');
  return text.length > limit ? `${sliceSafe(text, limit)}\n[cortado a ${limit} caracteres]` : text;
}

/**
 * Lee la PR, el commit, la comparación o la issue y devuelve el texto para el modelo:
 * cabecera, avisos, ficheros y diff (o descripción y comentarios), acotado a `maxChars`.
 */
export async function githubReviewText(
  target: GithubTarget,
  opts: { fetchFn?: GithubFetch; token?: string; maxChars?: number } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? (fetch as GithubFetch);
  const base = `https://api.github.com/repos/${target.owner}/${target.repo}`;
  const limit = opts.maxChars ?? 20_000;
  const head: string[] = [];
  let files: ChangedFile[];
  let mergeable: boolean | null | undefined;
  let body = '';
  /** Cuántos ficheros dice GitHub que cambian (si lo dice), para saber si la lista vino cortada. */
  let totalFiles = 0;
  const extra: string[] = [];
  if (target.kind === 'issue') {
    const issue = (await getJson(fetchFn, `${base}/issues/${target.ref}`, opts.token)) as Record<
      string,
      unknown
    >;
    // Un enlace /issues/N de una PR: se revisa como PR (con su diff).
    if (issue.pull_request) return githubReviewText({ ...target, kind: 'pull' }, opts);
    return issueText(fetchFn, base, target, issue, opts.token, limit);
  }
  if (target.kind === 'pull') {
    const pr = (await getJson(fetchFn, `${base}/pulls/${target.ref}`, opts.token)) as Record<
      string,
      unknown
    >;
    const user = (pr.user as { login?: string } | undefined)?.login ?? '?';
    const state = pr.merged
      ? 'fusionada'
      : pr.state === 'closed'
        ? 'cerrada sin fusionar'
        : pr.draft
          ? 'borrador'
          : 'abierta';
    const b = (pr.base as { ref?: string } | undefined)?.ref ?? '?';
    const h = (pr.head as { ref?: string } | undefined)?.ref ?? '?';
    mergeable = typeof pr.mergeable === 'boolean' ? pr.mergeable : null;
    totalFiles = n(pr.changed_files);
    head.push(
      `Pull request #${target.ref} de ${target.owner}/${target.repo}: «${str(pr.title)}»`,
      `Autor: ${user} · Estado: ${state} · ${b} ← ${h} · ${n(pr.commits)} commits, ${n(pr.changed_files)} ficheros, +${n(pr.additions)} −${n(pr.deletions)}`,
    );
    body = str(pr.body).trim();
    files = toFiles(
      await getJson(fetchFn, `${base}/pulls/${target.ref}/files?per_page=100`, opts.token),
    );
  } else if (target.kind === 'compare') {
    const cmp = (await getJson(fetchFn, `${base}/compare/${target.ref}`, opts.token)) as Record<
      string,
      unknown
    >;
    const [from, to] = target.ref.split('...');
    files = toFiles(cmp.files);
    const status: Record<string, string> = {
      ahead: 'por delante',
      behind: 'por detrás',
      diverged: 'separadas',
      identical: 'idénticas',
    };
    const add = files.reduce((k, f) => k + f.additions, 0);
    const del = files.reduce((k, f) => k + f.deletions, 0);
    head.push(
      `Comparación ${from}...${to} de ${target.owner}/${target.repo} (${status[str(cmp.status)] ?? (str(cmp.status) || '?')})`,
      `${to} lleva ${n(cmp.ahead_by)} commits por delante y ${n(cmp.behind_by)} por detrás de ${from} · ${files.length} ficheros, +${add} −${del}`,
    );
    const commits = (Array.isArray(cmp.commits) ? cmp.commits : []) as Record<string, unknown>[];
    const total = Math.max(n(cmp.total_commits), commits.length);
    if (commits.length) {
      const shown = commits.slice(-20);
      extra.push(
        '',
        total > shown.length ? `Commits (últimos ${shown.length} de ${total}):` : 'Commits:',
        ...shown.map((c) => {
          const commit = (c.commit ?? {}) as { message?: string; author?: { name?: string } };
          const title = str(commit.message).split('\n')[0] ?? '';
          return `- ${str(c.sha).slice(0, 7)} ${cut(title, 120)} (${commit.author?.name ?? '?'})`;
        }),
      );
    }
    // La API de comparar devuelve como mucho 300 ficheros.
    if (files.length >= 300) totalFiles = files.length + 1;
  } else {
    const c = (await getJson(fetchFn, `${base}/commits/${target.ref}`, opts.token)) as Record<
      string,
      unknown
    >;
    const commit = (c.commit ?? {}) as {
      message?: string;
      author?: { name?: string; date?: string };
    };
    const stats = (c.stats ?? {}) as { additions?: number; deletions?: number };
    const [title, ...rest] = str(commit.message).split('\n');
    head.push(
      `Commit ${target.ref.slice(0, 7)} de ${target.owner}/${target.repo}: «${title ?? ''}»`,
      `Autor: ${commit.author?.name ?? '?'} · ${str(commit.author?.date).slice(0, 10)} · +${n(stats.additions)} −${n(stats.deletions)}`,
    );
    body = rest.join('\n').trim();
    files = toFiles(c.files);
  }
  const flags = riskFlags(files, { mergeable });
  const omitted = omittedDiff(files);
  if (omitted.length)
    flags.push(
      `GitHub no da el diff de ${omitted.length} ${omitted.length === 1 ? 'fichero' : 'ficheros'} por ser demasiado grande (${omitted
        .slice(0, 4)
        .map((f) => `${f.filename} +${f.additions} −${f.deletions}`)
        .join(
          ', ',
        )}${omitted.length > 4 ? ` y ${omitted.length - 4} más` : ''}): esos cambios no se ven aquí; si importan, hay que abrirlos en GitHub.`,
    );
  if (totalFiles > files.length)
    flags.push(
      target.kind === 'compare'
        ? `GitHub solo lista los primeros ${files.length} ficheros de esta comparación: el resto no se ha revisado.`
        : `GitHub solo ha devuelto ${files.length} de ${totalFiles} ficheros: el resto no se ha revisado.`,
    );
  const noDiff = new Set(omitted.map((f) => f.filename));
  const lines = [...head];
  if (body) lines.push('', 'Descripción:', body.length > 1500 ? `${sliceSafe(body, 1500)}…` : body);
  lines.push(...extra);
  lines.push(
    '',
    'Avisos automáticos:',
    ...(flags.length ? flags.map((f) => `- ${f}`) : ['- Ninguno.']),
  );
  lines.push(
    '',
    `Ficheros (${files.length}):`,
    ...files.map(
      (f) =>
        `- ${f.filename} (${f.status ?? 'modified'}, +${f.additions} −${f.deletions})${noDiff.has(f.filename) ? ' [sin diff: demasiado grande para GitHub]' : ''}`,
    ),
  );
  lines.push('', 'Diff:');
  let text = lines.join('\n');
  for (const f of files) {
    if (!f.patch) continue;
    const chunk = `\n--- ${f.filename}\n${f.patch}\n`;
    if (text.length + chunk.length > limit) {
      text += `\n[diff cortado a ${limit} caracteres]`;
      break;
    }
    text += chunk;
  }
  return text;
}

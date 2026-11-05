/**
 * «Revisa este PR»: un enlace de GitHub a una pull request o a un commit se lee por la API
 * pública de GitHub en vez de la página (que es HTML pesado y casi todo menú). Devuelve lo
 * que hace falta para resumir y avisar de riesgos: título, autor, estado, ramas, ficheros
 * con líneas +/−, avisos automáticos (dependencias, CI, migraciones, secretos o permisos,
 * borrados grandes, código sin tests, conflictos) y el diff, acotado. Solo lectura y sin
 * clave (con GITHUB_TOKEN en el entorno, también repos privados y más margen de cuota).
 */

import { sliceSafe } from '../text.js';

export interface GithubTarget {
  kind: 'pull' | 'commit';
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

/** La PR o el commit de un enlace de github.com, o null si es otra cosa. */
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

/**
 * Lee la PR o el commit y devuelve el texto para el modelo: cabecera, avisos, ficheros y
 * diff, acotado a `maxChars`.
 */
export async function githubReviewText(
  target: GithubTarget,
  opts: { fetchFn?: GithubFetch; token?: string; maxChars?: number } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? (fetch as GithubFetch);
  const base = `https://api.github.com/repos/${target.owner}/${target.repo}`;
  const head: string[] = [];
  let files: ChangedFile[];
  let mergeable: boolean | null | undefined;
  let body = '';
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
    head.push(
      `Pull request #${target.ref} de ${target.owner}/${target.repo}: «${str(pr.title)}»`,
      `Autor: ${user} · Estado: ${state} · ${b} ← ${h} · ${n(pr.commits)} commits, ${n(pr.changed_files)} ficheros, +${n(pr.additions)} −${n(pr.deletions)}`,
    );
    body = str(pr.body).trim();
    files = toFiles(
      await getJson(fetchFn, `${base}/pulls/${target.ref}/files?per_page=100`, opts.token),
    );
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
  const lines = [...head];
  if (body) lines.push('', 'Descripción:', body.length > 1500 ? `${sliceSafe(body, 1500)}…` : body);
  lines.push(
    '',
    'Avisos automáticos:',
    ...(flags.length ? flags.map((f) => `- ${f}`) : ['- Ninguno.']),
  );
  lines.push(
    '',
    `Ficheros (${files.length}):`,
    ...files.map(
      (f) => `- ${f.filename} (${f.status ?? 'modified'}, +${f.additions} −${f.deletions})`,
    ),
  );
  lines.push('', 'Diff:');
  const limit = opts.maxChars ?? 20_000;
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

/**
 * Avisos de GitHub (como los «when a GitHub event…» de Grok Bot): CI en rojo en la rama
 * principal (y cuando vuelve a verde), PR nueva, issue nueva y comentarios nuevos en los
 * repos que el dueño elige → un aviso por Telegram, sin pasar por el modelo (coste cero).
 *
 * Apagado salvo `PA_GITHUB_AVISOS=dueño/repo[,otro/repo@rama]`. Sondea la API de GitHub
 * con ETag (`If-None-Match`: una respuesta 304 no gasta cuota), respeta `X-Poll-Interval`,
 * se espera al reset si GitHub limita, dobla la espera tras un fallo de red, no consulta en
 * horas de silencio (lo pendiente llega al acabar) y con `PA_AHORRO=1` sondea 3 veces menos.
 * La primera pasada solo toma nota de lo que ya hay: nada de una avalancha al arrancar.
 * Lo que haces tú mismo (tus PR, tus comentarios) no se avisa, como en GitHub.
 */
import { execFile } from 'node:child_process';
import { log } from './log.js';
import { sliceSafe } from './text.js';

export interface GithubRepoWatch {
  repo: string;
  branch: string;
}

export interface GithubAvisosConfig {
  repos: GithubRepoWatch[];
  /** Cada cuánto se consulta en condiciones normales. */
  everyMs: number;
}

const MIN = 60_000;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const OFF = new Set(['', '0', 'no', 'off', 'false', 'apagado']);
const SI = new Set(['1', 'si', 'sí', 'true', 'yes', 'on', 'activado']);

/** Lee la configuración del .env; null = apagado (o sin ningún repo válido). */
export function githubAvisosConfig(
  env: NodeJS.ProcessEnv = process.env,
): GithubAvisosConfig | null {
  const raw = (env.PA_GITHUB_AVISOS ?? '').trim();
  if (OFF.has(raw.toLowerCase())) return null;
  const repos: GithubRepoWatch[] = [];
  for (const part of raw.split(/[,\s;]+/)) {
    const p = part
      .trim()
      .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
      .replace(/\/+$/, '');
    if (!p) continue;
    const [rawName = '', branch = ''] = p.split('@');
    const name = rawName.replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!REPO.test(name)) {
      log.warn('github-avisos: repo no válido en PA_GITHUB_AVISOS', { valor: sliceSafe(p, 80) });
      continue;
    }
    if (repos.some((r) => r.repo.toLowerCase() === name.toLowerCase())) continue;
    repos.push({ repo: name, branch: /^[\w./-]{1,100}$/.test(branch) ? branch : 'main' });
  }
  if (repos.length === 0) return null;
  const minutes = Number((env.PA_GITHUB_AVISOS_MIN ?? '').trim().replace(',', '.'));
  let every = Number.isFinite(minutes) && minutes > 0 ? minutes * MIN : 5 * MIN;
  every = Math.min(Math.max(every, 2 * MIN), 180 * MIN);
  if (SI.has((env.PA_AHORRO ?? '').trim().toLowerCase())) every = Math.max(every * 3, 15 * MIN);
  return { repos: repos.slice(0, 20), everyMs: every };
}

/** Estado guardado por repo (sobrevive a reinicios). */
interface RepoState {
  baselined: boolean;
  etagEvents?: string;
  etagRuns?: string;
  seenEvents: string[];
  seenRuns: string[];
  /** Último resultado conocido por flujo de CI (para el «otra vez en verde»). */
  lastConclusion: Record<string, string>;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function emptyState(): RepoState {
  return { baselined: false, seenEvents: [], seenRuns: [], lastConclusion: {} };
}

function readState(raw: string | null | undefined): RepoState {
  try {
    const s = JSON.parse(raw ?? '') as Partial<RepoState>;
    if (!s || typeof s !== 'object') return emptyState();
    return {
      baselined: s.baselined === true,
      etagEvents: typeof s.etagEvents === 'string' ? s.etagEvents : undefined,
      etagRuns: typeof s.etagRuns === 'string' ? s.etagRuns : undefined,
      seenEvents: Array.isArray(s.seenEvents)
        ? s.seenEvents.filter((x) => typeof x === 'string')
        : [],
      seenRuns: Array.isArray(s.seenRuns) ? s.seenRuns.filter((x) => typeof x === 'string') : [],
      lastConclusion:
        s.lastConclusion && typeof s.lastConclusion === 'object' ? { ...s.lastConclusion } : {},
    };
  } catch {
    return emptyState();
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${sliceSafe(t, max - 1).trimEnd()}…` : t;
}

/** Un evento del feed de GitHub convertido en aviso, o null si no interesa. */
export function eventNotice(repo: string, ev: unknown, self?: string): string | null {
  const e = rec(ev);
  const actor = str(rec(e.actor).login);
  if (self && actor.toLowerCase() === self.toLowerCase()) return null;
  const p = rec(e.payload);
  const who = actor ? ` de @${actor}` : '';
  switch (str(e.type)) {
    case 'PullRequestEvent': {
      if (str(p.action) !== 'opened') return null;
      const pr = rec(p.pull_request);
      return `🆕 PR #${String(pr.number ?? p.number ?? '?')} en ${repo}${who}: «${oneLine(str(pr.title), 120)}»\n${str(pr.html_url)}`.trim();
    }
    case 'IssuesEvent': {
      if (str(p.action) !== 'opened') return null;
      const is = rec(p.issue);
      return `🆕 Issue #${String(is.number ?? '?')} en ${repo}${who}: «${oneLine(str(is.title), 120)}»\n${str(is.html_url)}`.trim();
    }
    case 'IssueCommentEvent':
    case 'PullRequestReviewCommentEvent': {
      if (str(p.action) !== 'created') return null;
      const c = rec(p.comment);
      const on = rec(p.issue).number !== undefined ? rec(p.issue) : rec(p.pull_request);
      const kind =
        str(e.type) === 'PullRequestReviewCommentEvent' || rec(on).pull_request !== undefined
          ? 'la PR'
          : 'la issue';
      const body = oneLine(str(c.body), 200);
      return `💬 @${actor || 'alguien'} comentó en ${kind} #${String(on.number ?? '?')} «${oneLine(str(on.title), 80)}» (${repo})${body ? `: «${body}»` : ''}\n${str(c.html_url)}`.trim();
    }
    default:
      return null;
  }
}

export interface GithubAvisosDeps {
  config: GithubAvisosConfig;
  fetch: typeof fetch;
  kv: { get(key: string): string | null | undefined; set(key: string, value: string): void };
  /** Manda el aviso al DM del dueño; false si no se pudo (se reintenta en la siguiente pasada). */
  send: (text: string) => Promise<boolean>;
  now: () => number;
  quiet: (now: number) => boolean;
  /** Clave de GitHub (GITHUB_TOKEN o `gh auth token`), si hay. */
  token: () => Promise<string | undefined>;
}

const MAX_ITEMS = 8;
const HOUR = 60 * MIN;

export class GithubAvisos {
  readonly #d: GithubAvisosDeps;
  #fails = 0;
  #waitUntil = 0;
  #pollFloorMs = 0;
  #self: string | undefined | null = null;
  #disabled = false;

  constructor(deps: GithubAvisosDeps) {
    this.#d = deps;
  }

  get disabled(): boolean {
    return this.#disabled;
  }

  /** Cuánto esperar hasta la siguiente pasada. */
  nextDelayMs(): number {
    const d = this.#d;
    let base = d.config.everyMs;
    if (this.#noToken) base = Math.max(base, 10 * MIN);
    base = Math.max(base, this.#pollFloorMs);
    if (this.#fails > 0) base = Math.min(base * 2 ** this.#fails, HOUR);
    const wait = this.#waitUntil - d.now();
    return Math.max(base, Math.min(wait, HOUR), 30_000);
  }

  #noToken = false;

  async #api(
    path: string,
    token: string | undefined,
    etag?: string,
  ): Promise<{ status: number; body?: unknown; etag?: string; headers: Headers }> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'asistenta',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (etag) headers['If-None-Match'] = etag;
    const res = await this.#d.fetch(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const out = {
      status: res.status,
      etag: res.headers.get('etag') ?? undefined,
      headers: res.headers,
    };
    if (res.status === 304) return out;
    if (res.status === 401) {
      this.#disabled = true;
      throw new GithubAuthError();
    }
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const retry = Number(res.headers.get('retry-after'));
      const until =
        Number.isFinite(retry) && retry > 0
          ? this.#d.now() + retry * 1000
          : Number.isFinite(reset) && reset > 0
            ? reset * 1000 + 30_000
            : this.#d.now() + 15 * MIN;
      this.#waitUntil = Math.max(this.#waitUntil, until);
      throw new GithubRateError();
    }
    if (res.status === 404) return { ...out, body: undefined };
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    return { ...out, body: (await res.json()) as unknown };
  }

  async #whoAmI(token: string | undefined): Promise<string | undefined> {
    if (this.#self !== null) return this.#self;
    if (!token) return undefined;
    try {
      const r = await this.#api('/user', token);
      this.#self = str(rec(r.body).login) || undefined;
    } catch (err) {
      if (err instanceof GithubAuthError) throw err;
      return undefined;
    }
    return this.#self;
  }

  /** Una pasada por todos los repos. Devuelve el texto enviado (o null). */
  async tick(): Promise<string | null> {
    const d = this.#d;
    if (this.#disabled) return null;
    const now = d.now();
    if (now < this.#waitUntil || d.quiet(now)) return null;
    const token = await d.token().catch(() => undefined);
    this.#noToken = !token;
    const notices: string[] = [];
    const pending: Array<[string, RepoState]> = [];
    try {
      const self = await this.#whoAmI(token);
      for (const w of d.config.repos) {
        const key = `github-avisos:${w.repo.toLowerCase()}`;
        const st = readState(d.kv.get(key));
        const found = await this.#checkRepo(w, st, token, self);
        notices.push(...found);
        pending.push([key, st]);
      }
      this.#fails = 0;
    } catch (err) {
      if (err instanceof GithubAuthError) {
        log.warn('github-avisos: GitHub no acepta la clave (401); avisos de GitHub parados');
        await d
          .send(
            'Avisos de GitHub parados: GitHub no acepta la clave (GITHUB_TOKEN o la sesión de gh). Renuévala y reinicia.',
          )
          .catch(() => false);
        return null;
      }
      if (!(err instanceof GithubRateError)) {
        this.#fails = Math.min(this.#fails + 1, 6);
        log.warn('github-avisos: fallo al consultar GitHub', { err: String(err) });
      }
      // Lo de los repos ya revisados se guarda solo si no hay nada que avisar de ellos.
      if (notices.length > 0) return null;
      for (const [key, st] of pending) d.kv.set(key, JSON.stringify(st));
      return null;
    }
    if (notices.length > 0) {
      const text = composeNotices(notices);
      // Si Telegram no lo acepta, no se guarda nada: la próxima pasada lo vuelve a ver.
      if (!(await d.send(text).catch(() => false))) return null;
      for (const [key, st] of pending) d.kv.set(key, JSON.stringify(st));
      return text;
    }
    for (const [key, st] of pending) d.kv.set(key, JSON.stringify(st));
    return null;
  }

  async #checkRepo(
    w: GithubRepoWatch,
    st: RepoState,
    token: string | undefined,
    self: string | undefined,
  ): Promise<string[]> {
    const out: string[] = [];
    const first = !st.baselined;
    // 1) Feed de eventos: PR, issues y comentarios.
    const ev = await this.#api(`/repos/${w.repo}/events?per_page=50`, token, st.etagEvents);
    const poll = Number(ev.headers.get('x-poll-interval'));
    if (Number.isFinite(poll) && poll > 0)
      this.#pollFloorMs = Math.max(this.#pollFloorMs, poll * 1000);
    if (ev.status !== 304 && Array.isArray(ev.body)) {
      st.etagEvents = ev.etag;
      const list = [...ev.body].sort((a, b) =>
        str(rec(a).created_at).localeCompare(str(rec(b).created_at)),
      );
      for (const item of list) {
        const id = str(rec(item).id);
        if (!id || st.seenEvents.includes(id)) continue;
        st.seenEvents.push(id);
        if (first) continue;
        const n = eventNotice(w.repo, item, self);
        if (n) out.push(n);
      }
      st.seenEvents = st.seenEvents.slice(-300);
    }
    // 2) CI en la rama principal.
    const runs = await this.#api(
      `/repos/${w.repo}/actions/runs?branch=${encodeURIComponent(w.branch)}&per_page=20&exclude_pull_requests=true`,
      token,
      st.etagRuns,
    );
    if (runs.status !== 304 && runs.body !== undefined) {
      st.etagRuns = runs.etag;
      const list = Array.isArray(rec(runs.body).workflow_runs)
        ? [...(rec(runs.body).workflow_runs as unknown[])]
        : [];
      list.sort((a, b) => str(rec(a).created_at).localeCompare(str(rec(b).created_at)));
      const reds: Array<{ text: string; id: string }> = [];
      for (const r0 of list) {
        const r = rec(r0);
        if (str(r.status) !== 'completed') continue;
        const id = `${String(r.id)}:${String(r.run_attempt ?? 1)}`;
        if (st.seenRuns.includes(id)) continue;
        st.seenRuns.push(id);
        const flow = String(r.workflow_id ?? r.name ?? '?');
        const conclusion = str(r.conclusion);
        const before = st.lastConclusion[flow];
        if (FAILED.has(conclusion)) st.lastConclusion[flow] = 'failure';
        else if (conclusion === 'success') st.lastConclusion[flow] = 'success';
        if (first) continue;
        const name = oneLine(str(r.name) || 'CI', 60);
        const commit = oneLine(str(rec(r.head_commit).message).split('\n')[0] ?? '', 80);
        if (FAILED.has(conclusion)) {
          reds.push({
            id: String(r.id),
            text: `🔴 CI en rojo en ${w.branch} · ${w.repo}: ${name}${commit ? ` — «${commit}»` : ''}`,
          });
          out.push(`${reds[reds.length - 1]?.text}\n${str(r.html_url)}`);
        } else if (conclusion === 'success' && before === 'failure') {
          out.push(
            `🟢 CI otra vez en verde en ${w.branch} · ${w.repo}: ${name}\n${str(r.html_url)}`,
          );
        }
      }
      st.seenRuns = st.seenRuns.slice(-200);
      // Primer diagnóstico: qué job y qué paso fallaron (una consulta más, solo si hay rojo).
      for (const red of reds.slice(0, 3)) {
        const where = await this.#failedStep(w.repo, red.id, token).catch(() => '');
        if (!where) continue;
        const i = out.findIndex((t) => t.startsWith(red.text));
        if (i >= 0) out[i] = out[i]?.replace(red.text, `${red.text} (falló: ${where})`) ?? '';
      }
    }
    st.baselined = true;
    return out;
  }

  async #failedStep(repo: string, runId: string, token: string | undefined): Promise<string> {
    const r = await this.#api(
      `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=30`,
      token,
    );
    const jobs = Array.isArray(rec(r.body).jobs) ? (rec(r.body).jobs as unknown[]) : [];
    const job = jobs.map(rec).find((j) => FAILED.has(str(j.conclusion)));
    if (!job) return '';
    const steps = Array.isArray(job.steps) ? (job.steps as unknown[]).map(rec) : [];
    const step = steps.find((s) => FAILED.has(str(s.conclusion)));
    return oneLine(`${str(job.name)}${step ? ` › ${str(step.name)}` : ''}`, 100);
  }
}

class GithubAuthError extends Error {}
class GithubRateError extends Error {}

/** Junta los avisos de una pasada en un solo mensaje (como mucho 8 y «y N más»). */
export function composeNotices(notices: readonly string[]): string {
  const shown = notices.slice(0, MAX_ITEMS);
  const more = notices.length - shown.length;
  const head = notices.length > 1 ? 'GitHub:\n\n' : '';
  return `${head}${shown.join('\n\n')}${more > 0 ? `\n\n…y ${more} más en GitHub.` : ''}`;
}

/** Clave de GitHub: GITHUB_TOKEN / GH_TOKEN, o la sesión de `gh` si está instalado. */
export function githubTokenSource(
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<string | undefined> {
  let cached: { value: string | undefined; at: number } | null = null;
  return async () => {
    const fromEnv = (env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '').trim();
    if (fromEnv) return fromEnv;
    if (cached && Date.now() - cached.at < 6 * HOUR) return cached.value;
    const value = await new Promise<string | undefined>((resolve) => {
      try {
        execFile(
          'gh',
          ['auth', 'token'],
          {
            timeout: 5_000,
            windowsHide: true,
            env: { ...env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
          },
          (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined),
        );
      } catch {
        resolve(undefined);
      }
    });
    cached = { value, at: Date.now() };
    return value;
  };
}

/** Arranca el bucle (temporizador que no mantiene vivo el proceso). Devuelve cómo pararlo. */
export function startGithubAvisos(avisos: GithubAvisos): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = (delay: number) => {
    if (stopped || avisos.disabled) return;
    timer = setTimeout(() => {
      void avisos
        .tick()
        .catch((err) => log.warn('github-avisos: pasada fallida', { err: String(err) }))
        .finally(() => loop(avisos.nextDelayMs()));
    }, delay);
    timer.unref?.();
  };
  loop(60_000);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

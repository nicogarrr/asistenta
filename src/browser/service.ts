import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { isFetchableResolved } from '../tools/fetch.js';
import {
  AD_ARGS,
  type AdSkipResult,
  clickSkipInPage,
  type MediaState,
  mediaStateInPage,
} from './ads.js';
import { type ChooseResult, chooseSuggestion } from './autocomplete.js';

/**
 * Real browser control, one persistent profile per chat.
 *
 * Why Playwright instead of driving the user's own Chrome over CDP: a real browser
 * gives the agent a DOM, selectors, network events and a login session that survives
 * a restart. That is the difference between "click at 440,347 and hope" and
 * `page.getByTestId('chat-list-search')`. Every previous attempt at browser work here
 * was coordinate-only, and coordinate-only on a page that reflows is what produced
 * the dead ends in the search bar.
 *
 * Three deliberate constraints:
 *
 * 1. One profile per chat, never shared. Cookies are the entire point of a persistent
 *    profile, and a shared one would make a logged-in session visible across chats.
 * 2. Navigation is approval-gated per domain, and a domain nobody approved cannot be
 *    reached at all — not by typing a URL, not by following a link, not by a redirect.
 * 3. The JavaScript sandbox gets `page` and `state` and nothing else: no `process`,
 *    no `require`, no `fs`. This is a tool that operates a browser, not a tool that
 *    runs arbitrary code on the host.
 */
export interface BrowserPolicy {
  /** Called before a new domain is used. Resolves true when the human approved. */
  approve(scope: string, domain: string, reason: string): Promise<boolean>;
  /** Hosts that are refused without asking. */
  deniedHosts?: string[];
  /**
   * Allow localhost, private ranges and metadata hosts. Off by default and not wired to
   * any config: it exists so tests can browse a local fixture server.
   */
  allowPrivateHosts?: boolean;
  /**
   * Approve domains without asking.
   *
   * This is the browser half of "full control" and it exists because the gate was
   * never the thing asking. With full control on, `browser open youtube.com` passed
   * the gate and then stopped here, in a separate layer with its own prompt, so the
   * user got "¿Abro youtube.com?" for the thing they had just asked for. Turning this
   * on does not weaken the `deniedHosts` wall below: those are still refused outright,
   * because a refuse is not a prompt and a full-control mode that could talk past it
   * would not be a wall.
   *
   * Every auto-approval is logged, so "where did it go" is still answerable.
   */
  autoApprove?: boolean;
  /**
   * How often to look for an advert skip button on this page.
   *
   * 0 disables the poll. The default is on because an advert the user is watching
   * while the agent works is worse for them than for the agent: it costs them time and
   * attention, and it delays the thing they actually asked for.
   */
  adSkipIntervalMs?: number;
}

/**
 * Which browser to drive. 'chrome' and 'msedge' are the ones installed on this PC (a
 * real fingerprint, which anti-bot systems trust far more than Playwright's bundled
 * Chromium); 'chromium' is the bundled copy.
 */
export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

/** What a page shows, as far as telling a challenge from a normal page is concerned. */
export interface ChallengeSignals {
  url: string;
  title: string;
  text: string;
  /** Sources of the iframes that are on screen (invisible ones are filtered out first). */
  frames: string[];
}

export type ChallengeKind = 'cloudflare' | 'recaptcha' | 'hcaptcha' | 'verify_human';

// Anchored to the start of the title: a real interstitial is titled "Just a moment...",
// "Un momento...", "Attention Required! | Cloudflare". An article or product called
// "Un momento para recordar" or "Security check-in tips" is not one.
const CHALLENGE_TITLE =
  /^\s*(?:just a moment|un momento|un instante|attention required|verifying you are human|checking your browser|security check|comprobaci[oó]n de seguridad)\s*(?:\.{2,}|…|!)?\s*(?:\|\s*cloudflare)?\s*$/i;
/** A challenge page is nearly empty; a long page that merely mentions captchas is content. */
const CHALLENGE_TEXT_MAX_LEN = 800;
const CHALLENGE_TEXT =
  /verify you are human|verifying you are human|verifica que eres (?:un )?humano|are you a robot|i'?m not a robot|no soy un robot|press (?:&|and) hold|unusual traffic|tr[aá]fico inusual|complete the security check|checking if the site connection is secure/i;

/**
 * Decide from what a page shows whether a person has to step in. Pure, so it is tested
 * without a browser.
 *
 * Conservative about frames on purpose: a page that merely embeds a Turnstile or
 * reCAPTCHA widget in a form is not blocking anyone, so a captcha frame only counts
 * when the page also reads like a challenge (title or text). Invisible frames are
 * dropped before this is called.
 */
export function classifyChallenge(sig: ChallengeSignals): ChallengeKind | null {
  const text = sig.text.slice(0, 3000);
  const frames = sig.frames.map((f) => f.toLowerCase());
  // A title with a site suffix ("Un momento - Mi blog") is a page, not an interstitial.
  const titled = CHALLENGE_TITLE.test(sig.title);
  const captchaFrame = frames.some((f) =>
    /challenges\.cloudflare\.com|recaptcha|hcaptcha\.com/.test(f),
  );
  const worded =
    CHALLENGE_TEXT.test(text) && (sig.text.length <= CHALLENGE_TEXT_MAX_LEN || captchaFrame);
  const cloudflareFrame = frames.some((f) => f.includes('challenges.cloudflare.com'));
  if (cloudflareFrame && (titled || worded)) return 'cloudflare';
  if (titled && /cloudflare|cf-chl|ray id/i.test(text)) return 'cloudflare';
  if (/google\.[a-z.]+\/sorry\//.test(sig.url)) return 'recaptcha';
  if (frames.some((f) => f.includes('google.com/recaptcha') || f.includes('recaptcha.net'))) {
    if (worded || titled) return 'recaptcha';
  }
  if (frames.some((f) => f.includes('hcaptcha.com')) && (worded || titled)) return 'hcaptcha';
  if (titled || worded) return 'verify_human';
  return null;
}

/** Runs inside the page, so it is a string: nothing from this module exists there. */
const CHALLENGE_PROBE = `(() => {
  const frames = [];
  for (const f of document.querySelectorAll('iframe')) {
    const r = f.getBoundingClientRect();
    const src = f.src || '';
    if (r.width < 30 || r.height < 30 || /size=invisible/.test(src)) continue;
    frames.push(src);
  }
  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    text: ((document.body && document.body.innerText) || '').slice(0, 3000),
    frames,
  });
})()`;

/** True when Playwright could not start the requested installed browser because it is absent. */
export function isMissingBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /distribution '[^']+' is not found|executable doesn't exist/i.test(msg);
}

export interface BrowserServiceOptions {
  policy: BrowserPolicy;
  /** Default 'chromium', so a bare service behaves as before; the daemon passes config. */
  channel?: BrowserChannel;
  /** Per-call ceiling for navigation and for evaluated code. */
  timeoutMs?: number;
  headless?: boolean;
  profilesDir?: string;
  /** Viewport for the headless page; defaults to a common laptop size. */
  viewport?: { width: number; height: number };
}

/** Result of one `exec_js`: text always, plus where the page ended up. */
export interface ExecJsResult {
  text: string;
  console: string[];
  /** True when the call was abandoned at the timeout while code was still running. */
  timedOut: boolean;
  /** Set when the code navigated somewhere new, so the model knows the page changed. */
  url?: string;
}

/**
 * Hosts that are never worth asking about. These are the ones where an agent with a
 * browser is one navigation away from an irreversible or account-locking action, and
 * where "approve once" is the wrong shape of consent: logging into a bank is not the
 * same kind of act as reading a news site.
 */
const DEFAULT_DENIED = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'id.apple.com',
  'paypal.com',
  'checkout.stripe.com',
  'secure.chase.com',
];

interface Session {
  context: BrowserContext;
  page: Page;
  /**
   * Whether the window is on screen and audible. Headless Chromium has no audio
   * output device at all, so a video "plays" silently and the model reports that it is
   * sounding when nothing can be heard. Media has to run in a visible window.
   */
  visible: boolean;
  /** The browser actually running; differs from the requested one after a fallback. */
  channel: BrowserChannel;
  /** vm context holding `page`, `state` and what the agent put on it. */
  sandbox: vm.Context;
  /** Domains the human approved for this chat. */
  granted: Set<string>;
  /** Serialises code evaluation: two scripts sharing JS state cannot overlap. */
  tail: Promise<unknown>;
  console: string[];
  /** Sites this session has been approved to visit, for the turn summary. */
  visited: string[];
  /** The advert-skip poll, and what it has achieved on this page. */
  adSkip: {
    timer: ReturnType<typeof setTimeout> | null;
    intervalMs: number;
    /** Button presses, so "it skipped 3 adverts" is a fact and not a claim. */
    skipped: number;
    polls: number;
    lastAt: string | null;
    /** Set while the page is gone, so a stale timer cannot click on a new page. */
    generation: number;
  };
}

/** Hostname of a URL, or null when the string is not a URL. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Whether `host` is `domain` or a subdomain of it.
 *
 * Exact matching would treat `web.whatsapp.com` as a different site from
 * `whatsapp.com`, and the agent would re-ask for approval on every redirect of the
 * same site. The check is anchored on a dot so `renfe.com` does not cover
 * `renfe.com.evil.net`.
 */
export function domainCovers(domain: string, host: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  const h = host.toLowerCase().replace(/^www\./, '');
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Profile directory for a scope.
 *
 * The scope can be a chat key or a thread key with colons and a leading minus in it,
 * so it is hashed: 24 hex characters is collision-free at this scale and cannot
 * escape the profiles directory no matter what the scope contains.
 */
export function profileDirFor(scope: string, base = paths.browser): string {
  const hash = createHash('sha256').update(scope).digest('hex').slice(0, 24);
  return join(base, hash);
}

export class BrowserService {
  readonly #sessions = new Map<string, Session>();
  readonly #options: Required<Omit<BrowserServiceOptions, 'policy'>> & { policy: BrowserPolicy };

  constructor(options: BrowserServiceOptions) {
    this.#options = {
      policy: options.policy,
      channel: options.channel ?? 'chromium',
      timeoutMs: options.timeoutMs ?? 45_000,
      headless: options.headless ?? true,
      profilesDir: options.profilesDir ?? paths.browser,
      viewport: options.viewport ?? { width: 1440, height: 900 },
    };
  }

  /** Whether this chat's browser window is on screen right now. */
  isVisible(scope: string): boolean {
    return this.#sessions.get(scope)?.visible ?? false;
  }

  /** Whether this chat has a live browser. Cheap: no filesystem, no launch. */
  isOpen(scope: string): boolean {
    return this.#sessions.has(scope);
  }

  /**
   * Get or create the browser for a conversation.
   *
   * `visible` switches a headless session to a real on-screen window. It is sticky:
   * once a conversation has asked for a visible window it keeps it, because a page
   * with a playing video cannot go back to headless without losing the playback and
   * the sound with it.
   */
  async #session(scope: string, opts?: { visible?: boolean }): Promise<Session> {
    const wantVisible = opts?.visible ?? !this.#options.headless;
    const existing = this.#sessions.get(scope);
    if (existing) {
      if (wantVisible && !existing.visible) {
        // Relaunch rather than promoting a running context: Chromium cannot change
        // headless-ness in place, and a page mid-playback has to reload anyway. The
        // profile on disk keeps the login.
        log.info('browser relaunching visible', { scope });
        await this.close(scope);
      } else {
        return existing;
      }
    }

    const dir = profileDirFor(scope, this.#options.profilesDir);
    mkdirSync(dir, { recursive: true });
    const launchOptions = {
      headless: !wantVisible,
      viewport: this.#options.viewport,
      // Playwright adds --enable-automation by default; it only draws an infobar and
      // sets a flag sites can read, so it goes.
      ignoreDefaultArgs: ['--enable-automation'],
      // Hiding the automation flag costs nothing and keeps sites from serving a
      // degraded "we think you are a bot" page to the agent's own browser.
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        // A visible window is for media, and media that refuses to start because no
        // hand touched the page is exactly the "it says it is playing and it is not"
        // failure. This is a personal browser on the user's own machine, not a kiosk.
        '--autoplay-policy=no-user-gesture-required',
      ],
      // Ceiling on the launch itself. Page timeouts are set separately below because
      // launchPersistentContext has no navigation-timeout option.
      timeout: this.#options.timeoutMs,
    };
    const { context, channel } = await this.#launch(scope, dir, launchOptions);
    context.setDefaultTimeout(this.#options.timeoutMs);
    context.setDefaultNavigationTimeout(this.#options.timeoutMs);

    const page = context.pages()[0] ?? (await context.newPage());
    const session: Session = {
      context,
      page,
      visible: wantVisible,
      channel,
      // Code generation disabled: the sandbox may call the functions it is given, but
      // it cannot build new code from strings or wasm, which removes the eval/Function
      // side of the escape surface.
      sandbox: vm.createContext({}, { codeGeneration: { strings: false, wasm: false } }),
      // Restored from disk: "approve once" has to mean once, not once per restart.
      // Without this the user re-approves every site the agent has used all week,
      // which is what turns a permission prompt into noise.
      granted: new Set(this.#loadGrants(scope)),
      tail: Promise.resolve(),
      console: [],
      visited: [],
      adSkip: {
        timer: null,
        intervalMs: Math.max(250, this.#options.policy.adSkipIntervalMs ?? 1000),
        skipped: 0,
        polls: 0,
        lastAt: null,
        generation: 0,
      },
    };
    this.#sessions.set(scope, session);

    const captured = session.console;
    page.on('console', (msg) => {
      // Bounded: a page that logs in a loop would otherwise grow this array without
      // limit and ship megabytes of noise on every later call.
      if (captured.length >= 50) return;
      captured.push(`${msg.type()}: ${msg.text().slice(0, 500)}`);
    });

    this.#installPolicy(scope, session);
    this.#startAdSkip(scope, session);
    log.info('browser opened', { scope, headless: this.#options.headless, channel });
    return session;
  }

  /**
   * Start the browser, preferring the installed one.
   *
   * An installed Chrome/Edge gets its own profile directory (`<dir>-chrome`): a profile
   * written by Playwright's bundled Chromium can be newer than the installed browser,
   * and Chrome refuses or resets a profile from a newer version. The cost is that a
   * session logged in under the old bundled profile does not carry over once.
   * If the requested browser is not installed the bundled one starts instead, with the
   * original profile, and the fallback is logged. Any other launch error is real and
   * propagates (for example a profile lock held by another process).
   */
  async #launch(
    scope: string,
    dir: string,
    launchOptions: Parameters<typeof chromium.launchPersistentContext>[1],
  ): Promise<{ context: BrowserContext; channel: BrowserChannel }> {
    const wanted = this.#options.channel;
    if (wanted !== 'chromium') {
      try {
        const profile = `${dir}-${wanted}`;
        mkdirSync(profile, { recursive: true });
        const context = await chromium.launchPersistentContext(profile, {
          ...launchOptions,
          channel: wanted,
        });
        return { context, channel: wanted };
      } catch (err) {
        if (!isMissingBrowserError(err)) throw err;
        log.warn('browser channel not installed, using bundled chromium', { scope, wanted });
      }
    }
    return {
      context: await chromium.launchPersistentContext(dir, launchOptions),
      channel: 'chromium',
    };
  }

  /**
   * Is the current page a bot challenge or captcha that a person has to solve?
   *
   * Never tries to get past it: the answer exists so the caller can stop and hand the
   * page to the user instead of pretending the task went through. Returns null for a
   * normal page and also when the page cannot be inspected (mid-navigation), because a
   * guess either way would be worse than saying nothing.
   */
  async detectChallenge(
    scope: string,
  ): Promise<{ kind: ChallengeKind; url: string; title: string } | null> {
    const session = this.#sessions.get(scope);
    if (!session) return null;
    try {
      // A click or open may still be mid-navigation; the challenge page itself loads fast.
      await session.page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
      const raw = (await session.page.evaluate(CHALLENGE_PROBE)) as string;
      const sig = JSON.parse(raw) as ChallengeSignals;
      const kind = classifyChallenge(sig);
      return kind ? { kind, url: sig.url, title: sig.title } : null;
    } catch {
      return null;
    }
  }

  /**
   * Put the current page in front of the user: same profile, visible window, same URL,
   * so they can solve the challenge by hand and the clearance cookie lands in the
   * profile the agent keeps using. Returns false when nothing could be reopened.
   */
  async handToUser(scope: string): Promise<boolean> {
    const session = this.#sessions.get(scope);
    if (!session) return false;
    // Already on screen: reopening would reload the page under the user's hands.
    if (session.visible) return true;
    const url = session.page.url();
    try {
      await this.open(scope, url, { visible: true });
      return true;
    } catch (err) {
      log.warn('browser could not be shown to the user', { scope, err });
      return false;
    }
  }

  // ---- grants that survive a restart ---------------------------------------

  #grantsFile(): string {
    return join(this.#options.profilesDir, 'grants.json');
  }

  /**
   * Domains this scope has already been trusted with, from a previous run.
   *
   * Never throws: an unreadable or corrupt file means the agent re-asks, which is the
   * safe direction to fail in.
   */
  #loadGrants(scope: string): string[] {
    try {
      const raw = readFileSync(this.#grantsFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const entry =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)[scope]
          : undefined;
      return Array.isArray(entry) ? entry.filter((h): h is string => typeof h === 'string') : [];
    } catch {
      return [];
    }
  }

  #saveGrants(scope: string, session: Session): void {
    try {
      const all: Record<string, string[]> = {};
      try {
        Object.assign(all, JSON.parse(readFileSync(this.#grantsFile(), 'utf8')));
      } catch {
        // First write, or an unreadable file: start from whatever is in memory.
        for (const [key, value] of this.#sessions) {
          if (key !== scope) all[key] = [...value.granted];
        }
      }
      all[scope] = [...session.granted];
      mkdirSync(this.#options.profilesDir, { recursive: true });
      // Atomic replace: a half-written grants file would be parsed as corrupt and lose
      // every approval the user has given, which is the worst possible failure for the
      // file whose whole job is remembering approvals.
      const tmp = `${this.#grantsFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2));
      renameSync(tmp, this.#grantsFile());
    } catch (err) {
      log.warn('browser grants not saved', { err });
    }
  }

  // ---- automatic advert skipping -------------------------------------------

  /**
   * Poll the page for a skip button and press it.
   *
   * This is the difference between "the agent can skip adverts" and "the user does not
   * watch adverts while the agent works". The model-driven version was already in
   * place and it was not enough: it fires on the agent's schedule, and every step
   * between noticing and clicking costs a tool call, a token round trip and a model
   * decision. On a six-second pre-roll that arrives after the pre-roll.
   *
   * So the watcher is not optional and the model is not in the loop. It only presses
   * the narrow set of selectors in `ads.ts`, it never clicks anything else, and it
   * runs on a timer rather than on the model's schedule, so it costs no tokens.
   */
  #startAdSkip(scope: string, session: Session): void {
    if (session.adSkip.intervalMs <= 0) return;
    const tick = async (): Promise<void> => {
      // The session was closed or replaced while this timer was pending: this poll
      // would evaluate against whatever page is there now, so it stops for good.
      if (this.#sessions.get(scope) !== session) return;
      session.adSkip.polls++;
      try {
        const result = (await session.page.evaluate(clickSkipInPage, AD_ARGS)) as AdSkipResult;
        if (result.clicked > 0) {
          session.adSkip.skipped += result.clicked;
          session.adSkip.lastAt = new Date().toISOString();
          log.info('ad skipped', { buttons: result.clicked });
        }
      } catch (err) {
        // Navigating pages make evaluate throw. That is the normal case, not an error
        // worth surfacing: the next tick tries again.
        log.debug('ad skip poll skipped', { err });
      }
      session.adSkip.timer = setTimeout(() => void tick(), session.adSkip.intervalMs);
      session.adSkip.timer.unref?.();
    };
    session.adSkip.timer = setTimeout(() => void tick(), session.adSkip.intervalMs);
    session.adSkip.timer.unref?.();
  }

  /**
   * What the automatic skipper has achieved, for the model to report and for tests.
   */
  adSkipStats(scope: string): { polls: number; skipped: number; lastAt: string | null } {
    const session = this.#sessions.get(scope);
    return session
      ? {
          polls: session.adSkip.polls,
          skipped: session.adSkip.skipped,
          lastAt: session.adSkip.lastAt,
        }
      : { polls: 0, skipped: 0, lastAt: null };
  }

  /** Poll now, outside the schedule. Used by the `media` action's skip_ad. */
  async skipAdNow(scope: string): Promise<{ clicked: number; adShowing: boolean; total: number }> {
    const session = await this.#session(scope);
    session.adSkip.polls++;
    const result = (await session.page.evaluate(clickSkipInPage, AD_ARGS)) as AdSkipResult;
    if (result.clicked > 0) {
      session.adSkip.skipped += result.clicked;
      session.adSkip.lastAt = new Date().toISOString();
      log.info('ad skipped', { buttons: result.clicked });
    }
    return { ...result, total: session.adSkip.skipped };
  }

  /** Read the media state of the page in one evaluate. */
  async mediaState(scope: string): Promise<MediaState> {
    const session = await this.#session(scope);
    return (await session.page.evaluate(mediaStateInPage, AD_ARGS)) as MediaState;
  }

  /**
   * Domain enforcement at the network layer, not only at navigation.
   *
   * The rule is deliberately asymmetric, and the asymmetry is the design:
   *
   * - A *navigation* to a host nobody approved is asked about first, then blocked on
   *   refusal. That is the move the human cares about: where the agent may go.
   * - A navigation to a host on the sensitive list is refused outright.
   * - **Subresources load from any host, including the sensitive ones.** The first
   *   version of this aborted them too, and that is exactly why YouTube rendered as a
   *   blank rectangle for twenty minutes: every YouTube page pulls its sign-in widget
   *   from accounts.google.com, and killing that request kills the app's whole initial
   *   script chain. A page loading its own login widget is not the agent logging into
   *   a bank; treating the two as one act broke every site with a sign-in button. The
   *   residual risk - a page rendering a login form the agent could then type into - is
   *   handled by the gate's credential rules and by the system prompt's absolute ban on
   *   typing passwords, not by blanking the page.
   * - The sensitive list still refuses everything the agent *navigates* to: open, a
   *   link click, a redirect. That is the real threat and it stays closed.
   *
   * What this does not do is block exfiltration over a subresource: a page the agent
   * reads could beacon to a third party. Closing that completely means breaking every
   * CDN-backed site, so it is a stated trade-off rather than a pretence. The gate is
   * about where the agent *acts*, and every approval and refusal is logged.
   */
  /** A plain object whose constructor lives in the sandbox realm, not in ours. */
  #newSandboxState(sandbox: vm.Context): unknown {
    return vm.runInContext('({})', sandbox, { timeout: 1000 });
  }

  #installPolicy(scope: string, session: Session): void {
    const denied = [...(this.#options.policy.deniedHosts ?? []), ...DEFAULT_DENIED];
    void session.context.route('**/*', async (route) => {
      const request = route.request();
      const host = hostOf(request.url());
      if (!host) return route.abort();

      const isDocument = request.isNavigationRequest() && request.resourceType() === 'document';
      // Local and private destinations are refused before anything else, redirects
      // and frames included. Subresources (images, scripts, xhr) are not covered:
      // see the trade-off above.
      if (
        isDocument &&
        !this.#options.policy.allowPrivateHosts &&
        !(await isFetchableResolved(request.url()))
      ) {
        log.warn('browser navigation to a local or private address refused', { scope, host });
        return route.abort();
      }
      const blocked = denied.some((d) => domainCovers(d.trim(), host));
      if (blocked && isDocument) {
        log.warn('browser navigation to sensitive host refused', { scope, host });
        return route.abort();
      }
      // Everything else - scripts, styles, fonts, images, media, xhr - loads normally,
      // including from sensitive hosts. See the rationale above.
      if (!isDocument) return route.continue();

      // Only a top-level navigation is a destination the user has an opinion about.
      // An advert iframe is a document navigation too, and it was the single biggest
      // source of pointless prompts: every pre-roll on YouTube opens
      // tpc.googlesyndication.com in a frame, so the user was asked to approve an ad
      // server mid-song. A frame cannot navigate the user's browser anywhere new.
      const isTopLevel = request.frame() === session.page.mainFrame();
      if (!isTopLevel) return route.continue();

      if (this.#granted(session, host)) return route.continue();

      // A click or a redirect can move the browser somewhere the agent never named,
      // so approval is requested here rather than trusting open to be the only way in.
      // Aborting silently left a clicked link hanging until it timed out, which reads
      // to the model as "the click did nothing".
      const ok = await this.#allowHost(scope, session, host, `la pagina quiere llevarte a ${host}`);
      if (!ok) {
        log.warn('browser navigation to unapproved domain refused', { scope, host });
        return route.abort();
      }
      return route.continue();
    });
  }

  /**
   * Ask, or not, about one host. One place so the rule cannot differ between `open`
   * and a click that navigates.
   */
  async #allowHost(
    scope: string,
    session: Session,
    host: string,
    reason: string,
  ): Promise<boolean> {
    if (this.#granted(session, host)) return true;
    if (this.#options.policy.autoApprove) {
      this.#grant(scope, session, host);
      log.info('browser domain auto-approved', { scope, host, reason: 'full control' });
      return true;
    }
    const ok = await this.#options.policy.approve(scope, host, reason);
    if (!ok) return false;
    this.#grant(scope, session, host);
    log.info('browser domain approved', { scope, host });
    return true;
  }

  #grant(scope: string, session: Session, host: string): void {
    session.granted.add(host);
    if (!session.visited.includes(host)) session.visited.push(host);
    this.#saveGrants(scope, session);
  }

  #granted(session: Session, host: string): boolean {
    for (const domain of session.granted) {
      if (domainCovers(domain, host)) return true;
    }
    return false;
  }

  /**
   * Navigate. The domain must be approved first: this is the only place the agent can
   * choose a new destination, and it is the moment the human decides.
   */
  async open(
    scope: string,
    url: string,
    opts?: { visible?: boolean },
  ): Promise<{ url: string; title: string; status: number | null }> {
    const host = hostOf(url);
    if (!host) throw new Error(`no es una URL valida: ${url}`);

    // Before the approval prompt: the user must never be asked "¿Abro localhost?"
    // for something that would let the agent reach this machine's own services or
    // the cloud metadata endpoint.
    if (!this.#options.policy.allowPrivateHosts && !(await isFetchableResolved(url))) {
      throw new Error(
        `no abro ${host}: es una direccion local o privada (localhost, red interna, metadatos). ` +
          'El navegador solo abre sitios publicos http(s).',
      );
    }

    const denied = [...(this.#options.policy.deniedHosts ?? []), ...DEFAULT_DENIED];
    const blocked = denied.find((d) => domainCovers(d.trim(), host));
    if (blocked) {
      throw new Error(
        `no abro ${host}: esta en la lista de sitios sensibles (${blocked.trim()}). ` +
          'Si de verdad lo necesitas, quitalo de la lista de denegados.',
      );
    }

    const session = await this.#session(scope, { visible: opts?.visible });
    const allowed = await this.#allowHost(scope, session, host, `abrir ${host} en el navegador`);
    if (!allowed) throw new Error(`el usuario no autorizo el dominio ${host}`);

    const response = await session.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.#options.timeoutMs,
    });
    const finalHost = hostOf(session.page.url()) ?? host;
    // A redirect to a different host is a new destination: the approval was for the
    // URL the agent asked about, not for whatever it lands on.
    if (finalHost !== host && !this.#granted(session, finalHost)) {
      await this.close(scope);
      throw new Error(
        `${host} redirigio a ${finalHost}, que no esta autorizado. Pregunta al usuario antes de continuar.`,
      );
    }
    return {
      url: session.page.url(),
      title: await session.page.title(),
      status: response?.status() ?? null,
    };
  }

  /**
   * A compact text view of the page: title, url, and the interactive elements with
   * accessible names and a selector hint.
   *
   * This is the locator-first discovery step. The model reads this instead of a
   * screenshot and then targets elements by selector, which is what stops coordinate
   * guessing from being the default way to operate a page.
   */
  async snapshot(scope: string, limit = 120): Promise<string> {
    const session = await this.#session(scope);
    const raw = await session.page.evaluate((max: number) => {
      const interesting =
        'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick],[contenteditable]';
      const nodes = Array.from(document.querySelectorAll(interesting));
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const el of nodes) {
        if (lines.length >= max) break;
        const rect = el.getBoundingClientRect();
        // Zero-size elements are usually hidden; listing them sends the model after
        // buttons that cannot be clicked.
        if (rect.width === 0 && rect.height === 0) continue;
        const input = el as HTMLInputElement;
        const name =
          el.getAttribute('aria-label') ??
          input.placeholder ??
          (el.textContent ?? '').trim().slice(0, 80);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type') ? `[${el.getAttribute('type')}]` : '';
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
            : '';
        const testId = el.getAttribute('data-testid');
        const hint = testId ? ` [data-testid=${testId}]` : '';
        lines.push(`${tag}${type}${id}${cls}${hint} "${name.replace(/\s+/g, ' ')}"`);
      }
      return { title: document.title, url: location.href, lines, total: nodes.length };
    }, limit);
    return [
      `${raw.title}\n${raw.url}\n(${raw.lines.length} de ${raw.total} elementos interactivos)`,
      ...raw.lines,
    ].join('\n');
  }

  /** Screenshot of the page. PNG at the viewport size keeps the token cost sane. */
  async screenshot(scope: string, fullPage = false): Promise<{ mimeType: string; data: string }> {
    const session = await this.#session(scope);
    const buf = await session.page.screenshot({ type: 'png', fullPage, scale: 'css' });
    return { mimeType: 'image/png', data: buf.toString('base64') };
  }

  /**
   * Run agent-written JavaScript with `page` and `state` in scope.
   *
   * The sandbox is a per-chat vm context and `state` is a plain object living in it,
   * so `state.x = 1` in one call is still there in the next. That is the whole
   * persistence mechanism, and it is explicit on purpose: the code runs inside an
   * async IIFE so `await` and `return` work, and a `var` inside a function is
   * invisible to the caller. An earlier version promised that "variables persist
   * between calls", which was simply false — the IIFE scope swallowed them — so the
   * contract now names `state` instead of implying magic.
   *
   * The timeout abandons the promise rather than killing it, because Playwright
   * operations are not cancellable from outside. A hung call therefore leaves a
   * pending operation behind, which is exactly why the serialiser matters: one leaked
   * call must not end up queued in front of every later one.
   */
  /** Type into an autocomplete field, pick a suggestion by text and verify the value. */
  async autocomplete(
    scope: string,
    selector: string,
    text: string,
    option?: string,
  ): Promise<ChooseResult> {
    const session = await this.#session(scope);
    return chooseSuggestion(session.page, selector, text, option);
  }

  async execJs(scope: string, code: string, opts?: { visible?: boolean }): Promise<ExecJsResult> {
    const session = await this.#session(scope, { visible: opts?.visible });
    const script = new vm.Script(`(async () => {\n${code}\n})()`);

    const run = async (): Promise<ExecJsResult> => {
      session.console.length = 0;
      const context = session.sandbox as Record<string, unknown>;
      context.page = session.page;
      // Created once per session and never replaced, so a locator handle or a parsed
      // result stashed by the model survives to the next call. It is built INSIDE the
      // sandbox realm on purpose: a host-created plain object leaks the host Function
      // constructor through state.constructor.constructor, which is a well known way
      // out of a node:vm sandbox. Creating it here closes that route - the sandbox has
      // code generation disabled, so the sandbox Function cannot build code either.
      //
      // Honest limitation: page is still a live host object and Playwright returns host
      // objects from every call, so an escape through
      // page.getByRole(...).constructor.constructor is NOT closed here. Closing it
      // needs a child process with a mediated protocol. Until that lands, the system
      // prompt forbids touching .constructor and every browser call is logged.
      context.state ??= this.#newSandboxState(context);
      context.console = {
        log: (...args: unknown[]) => {
          if (session.console.length < 50) {
            session.console.push(
              args
                .map((a) => String(a))
                .join(' ')
                .slice(0, 500),
            );
          }
        },
      };

      const before = session.page.url();
      let timedOut = false;
      try {
        const promise = script.runInContext(context, {
          // Bounds synchronous code only; an infinite `while` dies here.
          timeout: this.#options.timeoutMs,
        }) as unknown;
        let timer: NodeJS.Timeout | undefined;
        const guard = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`el codigo del navegador paso de ${this.#options.timeoutMs}ms`));
          }, this.#options.timeoutMs);
        });
        let value: unknown;
        try {
          value = await Promise.race([Promise.resolve(promise), guard]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        // A click that navigated is reported explicitly. Without this the model keeps
        // reading the previous page's elements after the browser has moved, which is
        // how "I clicked and nothing happened, so I clicked again" happens.
        const after = session.page.url();
        return {
          text: formatValue(value),
          console: [...session.console],
          timedOut,
          url: after === before ? undefined : after,
        };
      } catch (err) {
        // A thrown error inside the sandbox is information the model needs verbatim
        // (a Playwright timeout names the selector that failed), so it is returned as
        // the tool result rather than swallowed into a generic failure.
        return {
          text: `error: ${err instanceof Error ? err.message : String(err)}`,
          console: [...session.console],
          timedOut,
        };
      }
    };

    // Serialised: two scripts sharing one JS context cannot run concurrently.
    const next = session.tail.then(run, run);
    session.tail = next.catch(() => {});
    return next;
  }

  /** Go back. Returns where the browser ended up, which may be nowhere. */
  async back(scope: string): Promise<{ url: string; title: string }> {
    const session = await this.#session(scope);
    await session.page.goBack({ timeout: this.#options.timeoutMs }).catch(() => null);
    return { url: session.page.url(), title: await session.page.title() };
  }

  /**
   * Close one browser. The profile stays on disk on purpose: that is where the logged
   * in session lives, and throwing it away on every close would mean logging in again
   * for every task.
   */
  async close(scope: string): Promise<void> {
    const session = this.#sessions.get(scope);
    if (!session) return;
    this.#sessions.delete(scope);
    // The poll holds a reference to the session and would keep evaluating against a
    // closed context, throwing on every tick for as long as the daemon runs.
    if (session.adSkip.timer) {
      clearTimeout(session.adSkip.timer);
      session.adSkip.timer = null;
    }
    this.#saveGrants(scope, session);
    await session.context
      .close()
      .catch((err: unknown) => log.warn('browser close failed', { err }));
    log.info('browser closed', { scope });
  }

  /** Close everything, so no Chromium outlives the daemon and holds its profile lock. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((scope) => this.close(scope)));
  }

  /** Domains approved for a chat, for the turn summary and for tests. */
  grantedDomains(scope: string): string[] {
    return [...(this.#sessions.get(scope)?.granted ?? [])];
  }
}

/**
 * Render whatever the script returned.
 *
 * Objects are summarised rather than dumped: a raw Playwright handle serialises to a
 * page of internal fields the model cannot use, while the useful part (a list of
 * texts, a count, a URL) fits on one line. Depth is capped so a self-referential page
 * object cannot blow up the context.
 */
export function formatValue(value: unknown, depth = 0): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 8000 ? `${value.slice(0, 8000)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.slice(0, 40).map((v) => formatValue(v, depth + 1));
    const more = value.length > 40 ? `, ...+${value.length - 40} mas` : '';
    return `[${items.join(', ')}${more}]`;
  }
  if (typeof value === 'object') {
    if (depth > 2) return '{...}';
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    const body = entries.map(([k, v]) => `${k}: ${formatValue(v, depth + 1)}`).join(', ');
    return `{${body}}`;
  }
  return String(value);
}

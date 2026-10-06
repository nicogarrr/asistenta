import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { type BrowserContext, chromium, type Locator, type Page } from 'playwright';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { isFetchableResolved } from '../tools/fetch.js';
import { AD_ARGS, type AdSkipResult, type MediaState } from './ads.js';
import { type ChooseResult, chooseSuggestion } from './autocomplete.js';
import { callPageAdClick, callPageMediaState, callPageScan, installPageScan } from './inpage.js';
import { describeTarget, pageSummary } from './target.js';

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

/** Result of one `open`, including whether the requested URL had to be abandoned. */
export interface OpenResult {
  url: string;
  title: string;
  /** HTTP status of the requested URL, not of whatever it ended up on. */
  status: number | null;
  /** Whether the window is on screen, so the model can tell the user what they will see. */
  visible: boolean;
  /** True when the requested URL failed and the site root was loaded instead. */
  retryFromRoot?: boolean;
  /** The root that was tried. */
  retryUrl?: string;
  /** Status of that root: the reason to believe the site itself is alive. */
  statusAfterRetry?: number | null;
  /** Plain-language explanation of anything that went wrong. */
  note?: string;
}

/**
 * One interactive element of the page, described well enough to act on it.
 *
 * `name` alone was not enough to drive a real page. The production failure that
 * prompted these fields was an agent that could not tell a filled field from an empty
 * one: the date box already said 03/10, nothing in the snapshot said so, and the agent
 * typed over it. `value` exists so "what does this field currently say" is one snapshot
 * read instead of a guess.
 */
export interface PageElement {
  /** Position in document order. The model can refer to an element as `[3]`. */
  index: number;
  tag: string;
  /** Readable class: input, button, link, option, tab, checkbox, select, combobox, other. */
  kind: string;
  /** Declared or implied ARIA role, which is what `getByRole` matches on. */
  role: string | null;
  /** Accessible name: aria-label, label, placeholder, title, or the visible text. */
  name: string;
  /** Current value of a form control, or null when the element has none. */
  value: string | null;
  /** Best-effort selector that addresses exactly this element. */
  selector: string;
  /**
   * Suggestions currently open for THIS field. Reported per element because a panel is
   * only actionable through the field it belongs to, and a page can hold several
   * listboxes at once where only one of them is the one the model is driving.
   */
  openSuggestions: number;
}

/** One pass over the page: what is there, and which suggestion panels are open. */
export interface PageScan {
  title: string;
  url: string;
  /** Interactive elements in the DOM, before the cap. */
  total: number;
  /** Fields that have a suggestion panel open right now. */
  openSuggestions: number;
  /** Distinct panels currently on screen. */
  openPanels: number;
  /** Texts of those suggestions, in order, so the model can choose one by name. */
  suggestions: string[];
  /** The listed elements, capped. */
  elements: PageElement[];
}

/** Result of waiting for something to appear. */
export interface WaitResult {
  ok: boolean;
  /** The selector or text that was waited for. */
  waitedFor: string;
  /** How long it actually took. Zero when it was already there. */
  waitedMs: number;
  /** Why it did not appear, with what is on the page instead. */
  reason?: string;
  /** Elements currently on screen, closest match first. */
  candidates: string[];
  visible: boolean;
}

/** One entry of an open suggestion panel. */
export interface PickOption {
  /** Index within the option locator, so the click addresses the same node. */
  index: number;
  text: string;
}

/** Result of driving one autocomplete from focus to chosen value. */
export interface PickResult {
  ok: boolean;
  /** The value that was asked for. */
  label: string;
  /** The field it was typed into. */
  field: string;
  /** True when the field already held the value and nothing was typed. */
  alreadySet: boolean;
  /** What the field says now. */
  value: string;
  /** The suggestion that was pressed, or null when none was. */
  chosen: string | null;
  /** Every suggestion that was on screen, which is what makes a retry possible. */
  options: string[];
  waitedMs: number;
  reason?: string;
  visible: boolean;
}

/** Result of resolving a target to a locator, and optionally clicking it. */
export interface TargetResult {
  ok: boolean;
  /** What the model asked for. */
  target: string;
  /**
   * A CSS selector for the element, when one is known. Null when the element was found
   * by role, text or label, because those are not selectors and inventing one would be a
   * guess; `locatorJs` is what to use instead.
   */
  selector: string | null;
  /**
   * JavaScript expression that reproduces the locator, for `exec_js`. Always usable,
   * which is what makes "resolve now, act later" possible.
   */
  locatorJs: string;
  /** Which strategy matched, so the model can learn what works on this site. */
  how: string;
  /** Whether a click actually happened. Always false for a resolve-only call. */
  clicked: boolean;
  waitedMs: number;
  /** Failure text that names what was asked and what does exist. */
  error?: string;
  candidates: string[];
  visible: boolean;
}

/** One resolution of a target: the locator plus the two ways of naming it again. */
interface Resolved {
  locator: Locator;
  how: string;
  /** JS expression, always present. */
  js: string;
  /** CSS selector, present when the match came from one. */
  selector: string | null;
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

/**
 * Compare text the way a human does: without accents, without case, without the extra
 * spaces a DOM accumulates.
 *
 * This is what turns "Seleccionar Barcelona" and "seleccionar  barcelona" into the
 * same thing. Site labels are inconsistent about accents and casing even inside one
 * page, so an exact string match is a match that fails for no reason.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance, two rows, so a big page of candidates stays cheap. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? b.length;
}

/**
 * How close two labels are, 0 to 1.
 *
 * Used only to order candidates in an error message and to pick a last-resort target,
 * never to decide that an exact match was found. A substring match is scored high but
 * not maximal, so "Barcelona" outranks "Barcelona Sants" when either could do.
 */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ratio = 1 - editDistance(x, y) / Math.max(x.length, y.length);
  if (x.includes(y) || y.includes(x)) {
    const shorter = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return Math.max(ratio, 0.7 + 0.29 * shorter);
  }
  return ratio;
}

/**
 * Whether a target is a selector or a piece of text the model read off the page.
 *
 * Both are always tried; this only decides which one goes first. `getByText('Buscar')`
 * beats `locator('Buscar')`, and a CSS typo is worth noticing before five other
 * strategies run.
 */
export function looksLikeCssSelector(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^(text|role|id|xpath|css|nth|internal:)[= ]/i.test(v)) return true;
  if (/^[a-z]*(:|\[|#|\.)/i.test(v)) return true;
  return v.includes('>');
}

/**
 * Pick the suggestion that matches what was asked for.
 *
 * Tiers, in order: identical string, identical ignoring accents and case, starts with,
 * contains. Within a tier the shortest wins, which is what separates "Barcelona" from
 * "Barcelona Sants": both contain the text, only one is the thing that was asked for.
 * Returns the index in `texts`, or -1 when nothing is close enough.
 */
export function rankSuggestion(texts: readonly string[], label: string): number {
  const want = label.trim();
  const target = normalizeText(label);
  if (!target) return -1;
  const tiers: Array<(text: string) => boolean> = [
    (text) => text.trim() === want,
    (text) => normalizeText(text) === target,
    (text) => normalizeText(text).startsWith(target),
    (text) => normalizeText(text).includes(target),
  ];
  for (const match of tiers) {
    const hits = texts
      .map((text, index) => ({ index, len: text.trim().length }))
      .filter(({ index }) => match(texts[index] ?? ''));
    if (!hits.length) continue;
    hits.sort((x, y) => x.len - y.len || x.index - y.index);
    return hits[0]?.index ?? -1;
  }
  return -1;
}

/**
 * Candidates at or above this score come first in an error message.
 *
 * Listing is informational, so it is deliberately lenient: a wrong name in a sentence
 * costs the model one wasted glance, while omitting the right name costs it the only
 * clue it had. Everything else is still listed after these, ranked, because three
 * plausible names beat one.
 */
const SIMILAR_ENOUGH = 0.34;

/**
 * Minimum length ratio for a substring to count as the same thing.
 *
 * "Comprar ahora" for a button that says "Comprar" is a truncation and worth a click.
 * "Seleccionar Barcelona" for a button that says "Barcelona" is a different instruction
 * with a shared word, and pressing it books the wrong city. Both cases look identical
 * to a substring test, so the ratio decides: half the length is someone being brief,
 * well under half is a coincidence.
 */
const SUBSTRING_RATIO = 0.5;

/** How close two names must be, for names that are not one inside the other. */
const CLOSE_ENOUGH = 0.72;

/**
 * Whether a candidate name is the thing that was asked for, closely enough to click it.
 *
 * Separate from `similarity` on purpose. Similarity ranks; this decides. Rescuing a
 * click by resemblance is only safe when the two names are nearly the same name, so the
 * substring case demands most of the length and the rest demands a small edit distance.
 */
export function isSameName(target: string, candidate: string): boolean {
  const x = normalizeText(target);
  const y = normalizeText(candidate);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = Math.min(x.length, y.length);
  const longer = Math.max(x.length, y.length);
  if (x.includes(y) || y.includes(x)) return shorter / longer >= SUBSTRING_RATIO;
  return similarity(x, y) >= CLOSE_ENOUGH;
}

/**
 * The elements closest to what was asked for, as short quoted names.
 *
 * "No encontré 'Seleccionar Barcelona'" is a dead end: the model cannot tell whether it
 * should retype, use another selector, or give up. "Lo más parecido: 'Barcelona',
 * 'Barcelona Sants'" is a decision. Candidates that clear `SIMILAR_ENOUGH` lead; the
 * rest follow so the model still sees what is actually on the page when nothing is
 * close.
 */
export function closestCandidates(
  target: string,
  elements: readonly PageElement[],
  howMany = 6,
): string[] {
  const label = (el: PageElement): string => el.name || el.value || el.selector;
  const ranked = elements
    .map((el) => ({ el, score: similarity(target, `${el.name} ${el.value ?? ''}`) }))
    .sort((x, y) => y.score - x.score);
  const close = ranked.filter((r) => r.score >= SIMILAR_ENOUGH);
  const seen = new Set<PageElement>();
  const ordered = [...close, ...ranked].filter((r) => {
    if (seen.has(r.el)) return false;
    seen.add(r.el);
    return true;
  });
  return ordered.slice(0, howMany).map(({ el }) => label(el));
}

/** Roles tried, in order, when the model named a control instead of a selector. */
const RESCUE_ROLES = [
  'button',
  'link',
  'combobox',
  'textbox',
  'tab',
  'option',
  'checkbox',
  'menuitem',
  'switch',
] as const;

/**
 * Where an open suggestion panel keeps its items, most explicit first.
 *
 * `role=option` is the standard and it is first. Everything after it is a fallback for
 * the sites that never set a role, which is most of them, and the fallbacks are ordered
 * from "a listbox-ish container" to "anything that looks like a dropdown item" so the
 * panel that opened from the focused field wins over any unrelated list on the page.
 */
const OPTION_SELECTORS = [
  '[role=option]',
  '[role=menuitem]',
  '[role=listbox] li',
  '[role=listbox] [role=none]',
  'ul[role=listbox] > li',
  '[data-suggestion]',
  '[data-option]',
  '[class*=suggest] li',
  '[class*=suggestion] li',
  '[class*=autocomplete] li',
  '[class*=combobox] li',
  '[class*=dropdown] li',
  '[class*=option]',
  '[class*=Option]',
  '[class*=suggest]',
  '[class*=Suggest]',
  '[class*=autocomplete]',
  '[class*=Autocomplete]',
  '[class*=dropdown]',
  '[class*=Dropdown]',
];

/** Default wait. Long enough for a panel, short enough not to stall a turn. */
const WAIT_DEFAULT_MS = 3000;
/** Nobody waits longer than this for a panel to appear; above it something else is wrong. */
const WAIT_CEILING_MS = 30_000;
/** One probe of the page state. Short, so a slow guess does not eat the budget. */
const WAIT_SLICE_MS = 120;
/** Same idea for the rescue chain, where there are a dozen strategies to get through. */
const RESCUE_SLICE_MS = 250;
/** Actionability for the final click. */
const CLICK_MS = 3000;
/** How long a widget gets to write the picked value into its own field. */
const VALUE_WAIT_MS = 1200;

/** Clamp a model-supplied wait into the range that is safe to spend on it. */
function waitBudget(timeoutMs: number | undefined): number {
  const raw = Number(timeoutMs ?? WAIT_DEFAULT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return WAIT_DEFAULT_MS;
  return Math.min(WAIT_CEILING_MS, Math.max(100, Math.round(raw)));
}

/** How long the rescue chain may spend before falling back to similarity. */
function resolveBudget(timeoutMs: number | undefined): number {
  return Math.max(RESCUE_SLICE_MS, waitBudget(timeoutMs));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drop options that are just other options glued together.
 *
 * A panel whose container carries the same class as its rows yields both "Barcelona" and
 * "Barcelona Barcelona Sants". Keeping the second would let a substring match press the
 * wrong one, which is exactly the failure this whole feature exists to remove.
 */
function pruneOptions(options: readonly PickOption[]): PickOption[] {
  return options.filter((option) => {
    const mine = normalizeText(option.text);
    return !options.some((other) => {
      if (other === option) return false;
      const theirs = normalizeText(other.text);
      return theirs.length > 0 && theirs.length < mine.length && mine.includes(theirs);
    });
  });
}

/**
 * Render the snapshot for driving.
 *
 * Line shape: `selector[kind][role] value="..." "accessible name" [index]`.
 *
 * The selector leads because that is what gets typed into the next call. The kind and
 * the role come next because they say what kind of control it is and are what
 * `getByRole` needs. `value` is there because "the date field already says 03/10" was
 * invisible to the model and it typed over it. The index at the end is the fallback for
 * when a selector does not work.
 */
export function formatSnapshot(scan: PageScan): string {
  const lines = scan.elements.map((el) => {
    const role = el.role && el.role !== el.kind ? `[${el.role}]` : `[${el.kind}]`;
    const value = el.value?.trim() ? ` value="${el.value.replace(/\s+/g, ' ')}"` : '';
    const name = (el.name || el.selector).replace(/\s+/g, ' ').trim();
    // The panel count sits on the field's own line, because that is where the next
    // action goes. A count in the header would have to be matched back to a field by
    // reading, and the model would guess wrong as often as right.
    const open = el.openSuggestions > 0 ? ` ABIERTO:${el.openSuggestions} opciones` : '';
    return `${el.selector}${role}${value} "${name}" [${el.index}]${open}`;
  });
  const head = [
    `${scan.title}\n${scan.url}`,
    `(${scan.elements.length} de ${scan.total} elementos interactivos)`,
  ];
  // Reported first as well as per field, because "a panel is open" is the fact that
  // decides what to do next and should be impossible to miss.
  if (scan.openSuggestions > 0) {
    const shown = scan.suggestions
      .slice(0, 12)
      .map((s) => `"${s}"`)
      .join(', ');
    head.push(
      `ATENCION: ${scan.openSuggestions} campo(s) con sugerencias abiertas ahora mismo` +
        (shown ? `: ${shown}` : '') +
        '. Elige con action=pick, o pulsa la que quieras.',
    );
  }
  return [...head, ...lines].join('\n');
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

  /** Whether this chat has a live browser. Cheap: no filesystem, no launch. */
  isOpen(scope: string): boolean {
    return this.#sessions.has(scope);
  }

  /**
   * Whether the window is on screen, so the tool can tell the model whether the user
   * can watch it work.
   *
   * Reporting this on every result is the whole point: a headless browser is invisible
   * to the user, and an agent that cannot tell the difference will happily narrate
   * "he abierto la página" while nothing appears on the screen. Never creates a session.
   */
  isVisible(scope: string): boolean {
    return this.#sessions.get(scope)?.visible ?? false;
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
    // Page-side code is plain JS read at runtime, so it is installed rather than
    // serialised out of this module, which the bundler would have renamed.
    await installPageScan(page);
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
      // The headless window was closed to make room for the visible one. Without a
      // display the visible launch fails and leaves the conversation with no browser
      // (and sometimes a profile lock), so put the headless one back, best effort.
      await this.#restoreHeadless(scope, url);
      return false;
    }
  }

  async #restoreHeadless(scope: string, url: string): Promise<void> {
    if (this.#sessions.has(scope)) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.open(scope, url, { visible: false });
        return;
      } catch (err) {
        log.warn('browser could not be restored after a failed visible launch', {
          scope,
          attempt,
          err,
        });
        await new Promise((r) => setTimeout(r, 1500));
      }
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
        const result = await callPageAdClick<typeof AD_ARGS, AdSkipResult>(session.page, AD_ARGS);
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
    const result = await callPageAdClick<typeof AD_ARGS, AdSkipResult>(session.page, AD_ARGS);
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
    return callPageMediaState<typeof AD_ARGS, MediaState>(session.page, AD_ARGS);
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
   *
   * A 404 or a 5xx gets one automatic retry from the site root, because a dead deep
   * link is nearly always a URL the model made up: `renfe.com/es/es/inspirate/
   * experiencias/renfe-al-dia/rio` came straight out of a language model's memory and
   * does not exist. Burning a turn on that is avoidable, and the site root almost always
   * answers. The result says so (`retryFromRoot`), so the model knows it is now on the
   * home page and must not describe it as the page it asked for.
   */
  async open(scope: string, url: string, opts?: { visible?: boolean }): Promise<OpenResult> {
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

    const status = response?.status() ?? null;
    const base = { url: session.page.url(), title: await session.page.title(), status };
    if (status === null) {
      return {
        ...base,
        visible: session.visible,
        note: `${url} no devolvio ninguna respuesta (HTTP desconocido). Puede ser una pagina que solo carga con JavaScript, o un host que no contesta.`,
      };
    }
    if (status !== 404 && status < 500) {
      return { ...base, visible: session.visible };
    }

    const root = `${new URL(url).origin}/`;
    log.info('browser open failed, retrying from root', { scope, url, status, root });
    const retry = await session.page
      .goto(root, { waitUntil: 'domcontentloaded', timeout: this.#options.timeoutMs })
      .catch(() => null);
    const rootStatus = retry?.status() ?? null;
    const title = await session.page.title();
    if (rootStatus !== null && rootStatus < 400) {
      return {
        url: session.page.url(),
        title,
        status,
        visible: session.visible,
        retryFromRoot: true,
        retryUrl: root,
        statusAfterRetry: rootStatus,
        note: `${url} devolvio HTTP ${status}: esa URL no existe. He abierto la pagina principal del sitio (${root}, HTTP ${rootStatus}) en su lugar. Estas en la home, no en la pagina que pediste: sigue desde aqui con un snapshot.`,
      };
    }
    return {
      url: session.page.url(),
      title,
      status,
      visible: session.visible,
      retryFromRoot: false,
      retryUrl: root,
      statusAfterRetry: rootStatus,
      note: `${url} devolvio HTTP ${status} y la pagina principal (${root}) tampoco ha cargado (HTTP ${rootStatus ?? 'sin respuesta'}). El sitio no esta respondiendo o esa URL no es real. No sigas por aqui: prueba con otra pagina, o di al usuario que el sitio no carga.`,
    };
  }

  /**
   * A compact text view of the page: title, url, the interactive elements with their
   * role, their current value and a selector, plus any open suggestion panel.
   *
   * This is the locator-first discovery step. The model reads this instead of a
   * screenshot and then targets elements by selector, which is what stops coordinate
   * guessing from being the default way to operate a page.
   *
   * It is written for driving, not only for reading. Every line names the kind of
   * control, carries its ARIA role so `getByRole` can be used, shows the value a field
   * currently holds, and ends with the element's index so the model can refer to it by
   * position when a selector does not work. Open suggestions are announced before the
   * list, because "there are 4 suggestions open right now" is the fact that decides
   * the next action.
   */
  /** What the element behind `selector` is and does, for the permission gate. */
  async describeTarget(scope: string, selector: string): Promise<string> {
    const session = await this.#session(scope);
    return describeTarget(session.page, selector);
  }

  /** Amounts and address lines on the current page, for a payment confirmation. */
  async summarisePage(scope: string): Promise<string> {
    const session = await this.#session(scope);
    return pageSummary(session.page);
  }

  async snapshot(scope: string, limit = 120): Promise<string> {
    const scan = await this.elements(scope, limit);
    return formatSnapshot(scan);
  }

  /** The structured version of the snapshot, for anything that wants the fields. */
  async elements(scope: string, limit = 120): Promise<PageScan> {
    const session = await this.#session(scope);
    return this.#scan(session, limit);
  }

  /** One pass over the page. */
  async #scan(session: Session, limit: number): Promise<PageScan> {
    const capped = Math.max(1, Math.min(600, limit));
    return callPageScan<{ max: number }, PageScan>(session.page, { max: capped });
  }

  /**
   * Turn whatever the model said into a locator, trying strategies in order.
   *
   * This is the rescue chain, and the order is the whole design:
   *
   * 1. The literal selector, when the target looks like one. Nothing beats the thing the
   *    model was given by the page itself.
   * 2. ARIA roles, by accessible name. This is how a real accessibility tree is meant
   *    to be driven and it survives class-name churn.
   * 3. Visible text, then the label of a form control.
   * 4. Accent- and case-insensitive similarity against everything on screen.
   *
   * The production trace had twelve calls and one selector failure, and the single
   * selector failure ended the turn. A chain that ends with "the closest thing on the
   * page is 'Barcelona'" turns most of those wasted turns into a click.
   *
   * Each strategy gets a slice of the budget rather than the whole of it, so a slow
   * first guess cannot eat the time the later ones need, and the last stage keeps a
   * reserved share so a page with nothing remotely similar does not spend the whole
   * wait proving it, twelve slow times over, and then never get asked.
   */
  async #resolveLocator(
    session: Session,
    target: string,
    budgetMs: number,
  ): Promise<Resolved | null> {
    const page = session.page;
    const attempts: Array<{
      how: string;
      js: string;
      selector: string | null;
      make: () => Locator;
    }> = [];

    // Every strategy carries the JavaScript expression that reproduces it, because a
    // caller may act on the result later rather than right now - `fill` resolves a
    // field and then types into it. `Locator.toString()` is a debug rendering
    // ("locator('#a').first()"), not a selector, and feeding that back into
    // `page.locator(...)` fails; the expression below is what actually works.
    const name = JSON.stringify(target);
    if (looksLikeCssSelector(target)) {
      attempts.push({
        how: 'selector',
        js: `page.locator(${name}).first()`,
        selector: target,
        make: () => page.locator(target).first(),
      });
    }
    for (const role of RESCUE_ROLES) {
      attempts.push({
        how: `role:${role}`,
        js: `page.getByRole(${JSON.stringify(role)}, { name: ${name}, exact: false }).first()`,
        selector: null,
        make: () => page.getByRole(role, { name: target, exact: false }).first(),
      });
    }
    attempts.push({
      how: 'text',
      js: `page.getByText(${name}, { exact: false }).first()`,
      selector: null,
      make: () => page.getByText(target, { exact: false }).first(),
    });
    attempts.push({
      how: 'label',
      js: `page.getByLabel(${name}).first()`,
      selector: null,
      make: () => page.getByLabel(target).first(),
    });
    attempts.push({
      how: 'placeholder',
      js: `page.getByPlaceholder(${name}).first()`,
      selector: null,
      make: () => page.getByPlaceholder(target).first(),
    });

    const stageDeadline = Date.now() + Math.max(RESCUE_SLICE_MS, budgetMs - budgetMs / 3);
    for (const attempt of attempts) {
      const left = stageDeadline - Date.now();
      if (left <= 0) break;
      let locator: Locator;
      try {
        locator = attempt.make();
      } catch {
        // An unparseable selector is not a crash, it is just a strategy that did not
        // apply. The chain keeps going.
        continue;
      }
      const found = await locator
        .waitFor({ state: 'visible', timeout: Math.min(left, RESCUE_SLICE_MS) })
        .then(() => true)
        .catch(() => false);
      if (found) return { locator, how: attempt.how, js: attempt.js, selector: attempt.selector };
    }

    return this.#resolveBySimilarity(session, target);
  }

  /**
   * Last stage: find the element on screen whose text looks most like the target.
   *
   * The fuzzy comparison happens on the host, where accents and case can be handled
   * once, properly, and where it is testable; the click still goes through Playwright
   * with its actionability checks, using the selector the scan computed for that node.
   *
   * The bar here is `isSameName`, not the looser one used for error messages: a button
   * whose text merely shares a word with the requested text is not the requested
   * button, and a click on the wrong control books the wrong thing.
   *
   * Name and value are scored separately rather than glued together. Glued, a field
   * labelled "Destino" holding "Barcelona" reads as "Destino Barcelona" and swallows
   * any request that mentions Barcelona, which is how a request to press
   * "Seleccionar Barcelona" ends up pressing an input field.
   */
  async #resolveBySimilarity(session: Session, target: string): Promise<Resolved | null> {
    const scan = await this.#scan(session, 200).catch(() => null);
    if (!scan?.elements.length) return null;
    const ranked = scan.elements
      .map((el) => ({
        el,
        score: Math.max(similarity(target, el.name), el.value ? similarity(target, el.value) : 0),
      }))
      .sort((x, y) => y.score - x.score);
    const best = ranked[0];
    if (!best) return null;
    const sameName =
      isSameName(target, best.el.name) ||
      (best.el.value ? isSameName(target, best.el.value) : false);
    if (!sameName) return null;
    return {
      locator: session.page.locator(best.el.selector).first(),
      how: `similar:"${best.el.name || best.el.value}"`,
      js: `page.locator(${JSON.stringify(best.el.selector)}).first()`,
      selector: best.el.selector,
    };
  }

  /** Locate without acting. Used by `fill`, which must not click to find its field. */
  async resolveTarget(
    scope: string,
    target: string,
    opts?: { timeoutMs?: number },
  ): Promise<TargetResult> {
    const session = await this.#session(scope);
    const started = Date.now();
    const found = await this.#resolveLocator(session, target, resolveBudget(opts?.timeoutMs));
    if (!found) return this.#missingTarget(session, target, started, 'encontrar');
    return {
      ok: true,
      target,
      selector: found.selector,
      locatorJs: found.js,
      how: found.how,
      clicked: false,
      waitedMs: Date.now() - started,
      candidates: [],
      visible: session.visible,
    };
  }

  /**
   * Click whatever the model named, by selector or by the text it read on screen.
   *
   * A failure here returns `ok: false` with the closest existing candidates instead of
   * throwing. That is deliberate: a thrown tool error ended a real turn with
   * `stopReason: error` and the user got nothing, while a returned message keeps the
   * conversation alive and gives the model something to act on.
   */
  async clickTarget(
    scope: string,
    target: string,
    opts?: { timeoutMs?: number },
  ): Promise<TargetResult> {
    const session = await this.#session(scope);
    const started = Date.now();
    const found = await this.#resolveLocator(session, target, resolveBudget(opts?.timeoutMs));
    if (!found) return this.#missingTarget(session, target, started, 'hacer clic en');
    const clicked = await found.locator
      .click({ timeout: CLICK_MS })
      .then(() => true)
      .catch(() => false);
    if (!clicked) return this.#missingTarget(session, target, started, 'hacer clic en');
    return {
      ok: true,
      target,
      selector: found.selector,
      locatorJs: found.js,
      how: found.how,
      clicked: true,
      waitedMs: Date.now() - started,
      candidates: [],
      visible: session.visible,
    };
  }

  /** The failure text: what was asked for, and what does exist. */
  async #missingTarget(
    session: Session,
    target: string,
    started: number,
    verb: string,
  ): Promise<TargetResult> {
    let candidates: string[] = [];
    try {
      candidates = closestCandidates(target, (await this.#scan(session, 60)).elements);
    } catch {
      // A page that navigated mid-call cannot be scanned. The message still has to say
      // something useful, so it falls through to the "nothing to list" form below.
    }
    const what = candidates.length
      ? `Lo más parecido en la página ahora mismo: ${candidates.map((c) => `"${c}"`).join(', ')}.`
      : 'No hay elementos interactivos visibles en la página ahora mismo (puede haber cambiado o todavía estar cargando).';
    return {
      ok: false,
      target,
      selector: null,
      locatorJs: '',
      how: 'none',
      clicked: false,
      waitedMs: Date.now() - started,
      error: `No he podido ${verb} "${target}" con ningún selector ni texto. ${what} Vuelve a hacer action=snapshot: los selectores cambian al navegar.`,
      candidates,
      visible: session.visible,
    };
  }

  /**
   * Wait until something exists and is visible.
   *
   * The Renfe failure was not a bad selector, it was a panel that had not been painted
   * yet: the field was clicked, the model looked immediately, and concluded there were
   * no suggestions. Polling the real state for a bounded time is the difference between
   * that and a working search, and it costs one tool call instead of five.
   *
   * A miss is not an error. The model is told how long it waited and what is on the
   * page instead, because "it never appeared" without that is an unusable answer.
   */
  async waitFor(
    scope: string,
    target: { selector?: string | null; text?: string | null },
    timeoutMs = 3000,
  ): Promise<WaitResult> {
    const session = await this.#session(scope);
    const started = Date.now();
    const wanted: Array<{ label: string; make: () => Locator }> = [];
    const selector = target.selector?.trim() ?? '';
    const text = target.text?.trim() ?? '';
    if (selector) {
      wanted.push({ label: selector, make: () => session.page.locator(selector).first() });
    }
    if (text) {
      wanted.push({ label: text, make: () => session.page.getByText(text).first() });
    }
    if (!wanted.length) {
      return {
        ok: false,
        waitedFor: '',
        waitedMs: 0,
        reason: 'la acción wait necesita with= (un selector o un texto que esperar)',
        candidates: [],
        visible: session.visible,
      };
    }

    const budget = waitBudget(timeoutMs);
    for (const want of wanted) {
      const deadline = Math.min(started + budget, Date.now() + budget);
      while (Date.now() < deadline) {
        const slice = Math.min(WAIT_SLICE_MS, deadline - Date.now());
        let locator: Locator;
        try {
          locator = want.make();
        } catch (err) {
          return {
            ok: false,
            waitedFor: want.label,
            waitedMs: Date.now() - started,
            reason: `"${want.label}" no es un selector válido: ${messageOf(err)}`,
            candidates: [],
            visible: session.visible,
          };
        }
        const visible = await locator
          .waitFor({ state: 'visible', timeout: Math.max(1, slice) })
          .then(() => true)
          .catch(() => false);
        if (visible) {
          return {
            ok: true,
            waitedFor: want.label,
            waitedMs: Date.now() - started,
            candidates: [],
            visible: session.visible,
          };
        }
      }
    }

    const label = wanted.map((w) => w.label).join(' o ');
    const elements = await this.#scan(session, 60).then(
      (scan) => scan.elements,
      () => [] as PageElement[],
    );
    const candidates = closestCandidates(text || selector, elements);
    const now = elements.slice(0, 6).map((el) => el.name);
    return {
      ok: false,
      waitedFor: label,
      waitedMs: Date.now() - started,
      reason:
        `"${label}" no ha aparecido ni estaba visible en ${Date.now() - started}ms. ` +
        (candidates.length
          ? `Lo más parecido: ${candidates.map((c) => `"${c}"`).join(', ')}. `
          : '') +
        'Elementos visibles ahora mismo: ' +
        (now.length ? now.map((n) => `"${n}"`).join(', ') : '(ninguno)') +
        '.',
      candidates,
      visible: session.visible,
    };
  }

  /**
   * Drive one autocomplete from empty field to chosen value: focus, wait for the panel,
   * read the panel again, press the one that matches.
   *
   * This is the single most common way a real page beats an agent, and every step of it
   * used to be a separate tool call with its own failure mode. Four calls for one
   * dropdown is four chances to conclude "there is nothing there" from a panel that had
   * not rendered yet.
   *
   * Two properties make it safe to call blind:
   *
   * - Idempotent. A field that already holds the value is left alone and reported as
   *   already done, so a retry after an interruption costs nothing.
   * - Honest about failure. When nothing matches, the options that did appear come back
   *   in the message, because a retry is only possible if the model knows what to pick
   *   from.
   */
  async pick(
    scope: string,
    opts: { label: string; from: string; timeoutMs?: number },
  ): Promise<PickResult> {
    const session = await this.#session(scope);
    const started = Date.now();
    const label = opts.label.trim();
    const fail = (reason: string, options: string[] = [], value = ''): PickResult => ({
      ok: false,
      label,
      field: opts.from,
      alreadySet: false,
      value,
      chosen: null,
      options,
      waitedMs: Date.now() - started,
      reason,
      visible: session.visible,
    });
    if (!label) return fail('la acción pick necesita la etiqueta a elegir en with=');

    const found = await this.#resolveLocator(session, opts.from, resolveBudget(6000));
    if (!found) {
      const scan = await this.#scan(session, 60).catch(() => null);
      const candidates = scan ? closestCandidates(opts.from, scan.elements) : [];
      return fail(
        `No encuentro el campo "${opts.from}" para escribir "${label}". ` +
          (candidates.length
            ? `Lo más parecido en la página: ${candidates.map((c) => `"${c}"`).join(', ')}.`
            : 'Haz action=snapshot para ver los campos disponibles.'),
        [],
      );
    }
    const field = found.locator;

    // Already there? Say so and do nothing: retyping a chosen station can reopen the
    // panel and change the value the user actually picked.
    const current = await this.#readValue(field);
    if (normalizeText(current) === normalizeText(label)) {
      return {
        ok: true,
        label,
        field: opts.from,
        alreadySet: true,
        value: current,
        chosen: null,
        options: [],
        waitedMs: Date.now() - started,
        visible: session.visible,
      };
    }

    await field.click({ timeout: CLICK_MS }).catch(() => {});
    await field.fill('').catch(() => {});
    // Typed key by key rather than pasted: the panels that matter listen to
    // keystrokes, and `fill` fires a single input event that many of them ignore.
    await field.pressSequentially(label, { delay: 30 }).catch(async () => {
      await field.fill(label);
    });

    const panel = await this.#waitForOptions(session, waitBudget(opts?.timeoutMs ?? 3000));
    const texts = panel.options.map((o) => o.text);
    if (!texts.length) {
      return fail(
        `He escrito "${label}" en ${opts.from} pero no ha aparecido ninguna sugerencia. ` +
          'Puede que el campo no tenga autocompletado, o que las sugerencias ya se hayan ' +
          'cerrado. Mira el snapshot para ver como se llama el campo.',
        [],
        await this.#readValue(field),
      );
    }

    const at = rankSuggestion(texts, label);
    if (at < 0) {
      const listed = texts.map((t) => `"${t}"`).join(', ');
      return fail(
        `Ninguna de las sugerencias que aparecen contiene "${label}". ` +
          `Las que si hay: [${listed}]. Elige una de esas, o continua con lo que haya marcado.`,
        texts,
        await this.#readValue(field),
      );
    }

    const chosen = panel.options[at];
    await session.page
      .locator(panel.selector)
      .nth(chosen?.index ?? 0)
      .click({ timeout: CLICK_MS });
    const value = await this.#waitForValue(session, field, label);
    if (normalizeText(value) !== normalizeText(label)) {
      return fail(
        `He pulsado la sugerencia "${chosen?.text ?? ''}" pero el campo ${opts.from} se ha quedado con "${value}" en lugar de "${label}".`,
        texts,
        value,
      );
    }
    return {
      ok: true,
      label,
      field: opts.from,
      alreadySet: false,
      value,
      chosen: chosen?.text ?? label,
      options: texts,
      waitedMs: Date.now() - started,
      visible: session.visible,
    };
  }

  /** Current text of a field, whether it is an input or a div pretending to be one. */
  async #readValue(field: Locator): Promise<string> {
    const value = await field
      .first()
      .inputValue({ timeout: 800 })
      .catch(() => null);
    if (typeof value === 'string') return value;
    const text = await field
      .first()
      .textContent({ timeout: 800 })
      .catch(() => '');
    return (text ?? '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Poll for an open suggestion panel and read what is in it.
   *
   * The selector that produced the panel comes back with it, so the click that follows
   * addresses exactly the node that was read instead of a second guess. Nesting is
   * flattened: on sites that name the wrapper after the option, one match yields both
   * "Madrid" and "Madrid Madrid-Chamartín", and the second of those can win a substring
   * match against "Barcelona" on a different panel. Supersets are dropped.
   */
  async #waitForOptions(
    session: Session,
    timeoutMs: number,
  ): Promise<{ selector: string; options: PickOption[] }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of OPTION_SELECTORS) {
        const locator = session.page.locator(selector);
        const count = await locator.count().catch(() => 0);
        if (!count) continue;
        const found: PickOption[] = [];
        for (let i = 0; i < count; i++) {
          const text = (
            await locator
              .nth(i)
              .innerText({ timeout: 500 })
              .catch(() => '')
          )
            .replace(/\s+/g, ' ')
            .trim();
          if (text) found.push({ index: i, text });
        }
        const options = pruneOptions(found);
        if (options.length) return { selector, options };
      }
      await session.page.waitForTimeout(WAIT_SLICE_MS).catch(() => {});
    }
    return { selector: OPTION_SELECTORS[0] ?? '[role=option]', options: [] };
  }

  /** Give the widget a moment to write the chosen value into its own field. */
  async #waitForValue(session: Session, field: Locator, want: string): Promise<string> {
    const deadline = Date.now() + VALUE_WAIT_MS;
    let value = await this.#readValue(field);
    while (normalizeText(value) !== normalizeText(want) && Date.now() < deadline) {
      await session.page.waitForTimeout(100).catch(() => {});
      value = await this.#readValue(field);
    }
    return value;
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

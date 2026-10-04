/**
 * Advert skipping, in one place.
 *
 * Two entry points, both of which live in `ads-page.js` rather than here:
 *
 * - a poll from `BrowserService` presses the button the moment it appears. This is what
 *   actually stops the user watching a pre-roll: it does not wait for the model to
 *   notice, poll and call a tool, which takes a round trip and, on a six-second advert,
 *   arrives after the advert is over anyway.
 * - the `media` action in `tools/browser.ts`, which the model can call to report on an
 *   advert and to press the button on demand.
 *
 * Both go through the selectors below rather than each having their own, because a
 * skipper that works and a reporter that does not is worse than neither: the model
 * would report "no button to press" while the button was being pressed for it.
 *
 * The code that runs in the page is plain JavaScript in `ads-page.js`, read at runtime
 * and installed as a script, because page.evaluate serialises the function it is given
 * and runs the source in the browser: the module scope is gone and so is every helper
 * declared next to it. Bundled TypeScript made this worse rather than better, since
 * esbuild renames those nested declarations and appends __name() calls that do not exist
 * in the page. Nothing that runs in a page is written in this module.
 *
 * The CSS/text split is not cosmetic either. `button:has-text("Saltar")` is a
 * Playwright selector-engine extension, not a CSS selector: `document.querySelectorAll`
 * throws on it. The first skip script mixed the two, so `skip_ad` threw a SyntaxError
 * on every call and adverts were never skipped - the feature was in the code, in the
 * tool description and in the logs, and it had never once worked. A text match now
 * goes through `textContent`, like a person reads a label.
 */

/** CSS selectors for skip buttons, newest names first. All of them valid CSS. */
export const AD_SELECTORS = [
  '.ytp-ad-skip-button',
  '.ytp-ad-skip-button-modern',
  '.ytp-skip-ad-button',
  'button[id*="skip-button"]',
  '.ytp-ad-skip-button-container button',
  'button.ytp-ad-skip-button-slot',
  '.ytp-ad-skip-button-slot button',
];

/**
 * Button labels that mean "skip this advert", lowercased and accent-folded.
 *
 * Matching a *prefix* rather than equality: the button says "Saltar anuncio",
 * "Saltar publicidad" or "Skip ad", and an exact match on the shortest form would miss
 * all of them. A last resort - the class selectors above are tried first - so a page
 * with a button that merely starts with "skip" as part of its own UI is not pressed by
 * accident.
 */
export const AD_SKIP_TEXTS = ['saltar', 'skip ad', 'skip advertisement', 'skip'];

/** Marks an advert on screen, used to tell "playing" from "still in the advert". */
export const AD_VISIBLE_SELECTOR =
  '.ad-showing, .ytp-ad-player-overlay, [class*="ad-interrupting"], .ad-interrupting';

export interface AdSkipResult {
  /** Buttons pressed, 0 when there was nothing to press. */
  clicked: number;
  adShowing: boolean;
}

export interface MediaState {
  hasVideo: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  muted: boolean | null;
  adShowing: boolean;
  skipButtonsVisible: number;
  title: string;
}
/** The one argument the evaluated functions receive. Playwright allows exactly one. */
export interface AdSkipArgs {
  selectors: string[];
  texts: string[];
  adSelector: string;
}

/**
 * The one value to pass to `page.evaluate` for both evaluated functions.
 *
 * Playwright's `evaluate` takes exactly one argument, so the three pieces arrive as a
 * single object. Building it once means the skipper and the reporter can never be
 * handed different selectors, which is the failure mode a second copy would create.
 */
export const AD_ARGS: AdSkipArgs = {
  selectors: AD_SELECTORS,
  texts: AD_SKIP_TEXTS,
  adSelector: AD_VISIBLE_SELECTOR,
};

/**
 * Press every visible skip button, in the page.
 *
 * Self-contained on purpose: every helper and every constant it needs is either
 * inlined or passed in as an argument, because nothing outside the function body
 * survives the trip to the browser. That is also why this is a plain function and not
 * a closure over the module: a closure over `AD_SELECTORS` would serialise as an empty
 * reference and throw at the first poll.
 *
 * Playwright's `evaluate` accepts exactly one argument, so the three pieces arrive
 * packed in one object rather than as separate parameters.
 *
 * `offsetParent === null` is the cheap "is it actually on screen" test available from
 * inside the page: YouTube keeps every skip-button variant in the DOM and hides all but
 * one, so clicking blind would press a hidden button or the wrong player's.
 */

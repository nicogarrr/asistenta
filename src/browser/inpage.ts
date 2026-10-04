import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

/**
 * Installing page-side code without depending on the bundler.
 *
 * A function defined in this project cannot be handed to page.evaluate as-is. The build
 * tooling (esbuild with keepNames, used by tsx and vitest) rewrites nested function
 * declarations so they do not collide with module scope (`controlValue` ->
 * `controlValue2`), without always rewriting the call sites inside the same source range,
 * and it appends `__name(fn, "fn")` calls that reference a helper which does not exist in
 * the browser. page.evaluate works by calling toString() on the function and running
 * that source in the page, so the shipped source calls names the page never declares and
 * every evaluate dies with `ReferenceError`. The production build (tsc) happens to emit
 * valid output, which is why this only ever failed under tsx, in vitest and in the probe
 * scripts, and never in the running daemon.
 *
 * Rewriting the source to avoid arrows and declarations does not help: keepNames touches
 * function declarations too. So the page code lives in plain .js files that nothing
 * renames, is read at runtime and installed as a script tag. It then runs in the page's own
 * global scope, and evaluate only has to call one global by name.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Page scripts, read once and reused. */
const cache = new Map<string, string>();

function pageSource(file: string): string {
  let src = cache.get(file);
  if (src === undefined) {
    src = readFileSync(join(here, file), 'utf8');
    cache.set(file, src);
  }
  return src;
}

/** The minimal page surface this module needs, so it can be faked in tests. */
export interface PageHost {
  addInitScript(arg: { content: string }): Promise<unknown>;
  addScriptTag(arg: { content: string }): Promise<unknown>;
}

/**
 * Make the page-side code available in the page.
 *
 * addInitScript covers every document created from now on; addScriptTag covers the
 * document that is already loaded, since a context always starts with one open page.
 */
export async function installPageScan(page: PageHost): Promise<void> {
  await install(page, ['scan-page.js', 'ads-page.js']);
}

async function install(page: PageHost, files: string[]): Promise<void> {
  for (const file of files) {
    const content = pageSource(file);
    await page.addInitScript({ content }).catch(() => {});
    await page.addScriptTag({ content }).catch(() => {});
  }
}

/**
 * Call one of the installed functions by name.
 *
 * The arrow passed to evaluate comes from this module too, so it is subject to the same
 * renaming, but it only touches globalThis through a string name and calls whatever it
 * finds, which is why it survives the round trip.
 */
export async function callInstalled<TResult>(
  page: Pick<Page, 'evaluate'>,
  name: string,
  args: unknown,
): Promise<TResult> {
  return (await page.evaluate(
    ([fnName, payload]: [string, unknown]) => {
      const scope = globalThis as unknown as Record<string, (a: unknown) => unknown>;
      const fn = scope[fnName];
      if (typeof fn !== 'function') {
        throw new Error(`${String(fnName)} no esta instalado en la pagina`);
      }
      return fn(payload);
    },
    [name, args] as [string, unknown],
  )) as TResult;
}

/** One pass over the page: the interactive elements, their values, and open panels. */
export function callPageScan<TArgs, TResult>(
  page: Pick<Page, 'evaluate'>,
  args: TArgs,
): Promise<TResult> {
  return callInstalled<TResult>(page, '__paScanPage', args);
}

/** Click whatever ad-skip button is showing, and report what actually happened. */
export function callPageAdClick<TArgs, TResult>(
  page: Pick<Page, 'evaluate'>,
  args: TArgs,
): Promise<TResult> {
  return callInstalled<TResult>(page, '__paClickSkip', args);
}

/** Report what is playing, without claiming anything was skipped. */
export function callPageMediaState<TArgs, TResult>(
  page: Pick<Page, 'evaluate'>,
  args: TArgs,
): Promise<TResult> {
  return callInstalled<TResult>(page, '__paMediaState', args);
}

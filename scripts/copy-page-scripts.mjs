/**
 * Copy the page-side scripts into dist.
 *
 * The browser helpers live in plain .js files that `src/browser/inpage.ts` reads at
 * runtime, because page.evaluate serialises whatever function it is given and the
 * bundler rewrites nested declarations and __name() calls that do not exist in the page.
 * Keeping them as files is what makes them immune to that.
 *
 * tsc only emits .ts, so without this step the built daemon starts fine and then fails
 * on the first snapshot with ENOENT, which looks like a missing file rather than a
 * missing build step.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'browser');
const to = join(root, 'dist', 'browser');

mkdirSync(to, { recursive: true });

const copied = [];
for (const name of readdirSync(from)) {
  if (!name.endsWith('.js')) continue;
  copyFileSync(join(from, name), join(to, name));
  copied.push(name);
}

process.stdout.write(`page scripts copied: ${copied.join(', ')}\n`);

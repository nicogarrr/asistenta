import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

/**
 * Where Playwright keeps its browsers for the real user, worked out the way Playwright does
 * it (PLAYWRIGHT_BROWSERS_PATH, else the per-user cache folder).
 */
export function playwrightBrowsersPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const set = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (set) return set;
  if (platform === 'win32') {
    const home = env.USERPROFILE?.trim() || homedir();
    return win32.join(
      env.LOCALAPPDATA?.trim() || win32.join(home, 'AppData', 'Local'),
      'ms-playwright',
    );
  }
  const home = env.HOME?.trim() || homedir();
  if (platform === 'darwin') return posix.join(home, 'Library', 'Caches', 'ms-playwright');
  return posix.join(env.XDG_CACHE_HOME?.trim() || posix.join(home, '.cache'), 'ms-playwright');
}

/**
 * measure() runs the candidate with a throwaway home (cleanEnv), and Playwright looks for its
 * browsers under that home: the offline probe crashed on every run, so the base was never
 * measurable and no week could start. This puts a link to the real browsers where Playwright
 * looks inside the throwaway home, so the environment still carries no real path. Removing the
 * home removes the link, not the browsers.
 */
export function linkBrowsers(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  const real = playwrightBrowsersPath(env, platform);
  if (!real || real === '0' || !existsSync(real)) return;
  // The same folders cleanEnv points the candidate at (XDG_CACHE_HOME, LOCALAPPDATA).
  const fake =
    platform === 'win32'
      ? join(home, 'AppData', 'Local', 'ms-playwright')
      : platform === 'darwin'
        ? join(home, 'Library', 'Caches', 'ms-playwright')
        : join(home, '.cache', 'ms-playwright');
  try {
    mkdirSync(dirname(fake), { recursive: true });
    symlinkSync(real, fake, platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // Without the link the probe reports itself as not measured, as before.
  }
}

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import {
  downloadVideo,
  explainYtdlpError,
  parseImpersonateTargets,
  resetDownloadCachesForTests,
} from '../src/media/download.js';

const posix = process.platform !== 'win32';

describe('yt-dlp impersonation targets', () => {
  const table = [
    '[info] Available impersonate targets',
    'Client          OS          Source',
    '---------------------------------------',
    'Chrome-133      Macos-15    curl_cffi',
    'Chrome-136      Windows-10  curl_cffi',
    'Safari          -           curl_cffi (unavailable)',
  ].join('\n');

  it('picks chrome when it is usable', () => {
    expect(parseImpersonateTargets(table)).toBe('chrome');
  });

  it('returns null when the backend is missing or chrome is not listed', () => {
    expect(
      parseImpersonateTargets(
        'Chrome-133  Macos-15  curl_cffi (unavailable)\nSafari-18.0  Ios-18.0  curl_cffi',
      ),
    ).toBeNull();
    expect(parseImpersonateTargets('Safari - curl_cffi')).toBeNull();
    expect(parseImpersonateTargets('')).toBeNull();
  });
});

describe('explainYtdlpError, anti-bot cases', () => {
  const bot =
    "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser";

  it('does not call the bot check a private video', () => {
    const msg = explainYtdlpError(bot, { youtube: true, deno: true });
    expect(msg).not.toMatch(/privado/);
    expect(msg).toMatch(/no soy un robot/);
    expect(msg).toMatch(/PA_DOWNLOAD_COOKIES_BROWSER=firefox/);
  });

  it('tells the user to install deno when it is missing', () => {
    const msg = explainYtdlpError(bot, { youtube: true, deno: false });
    expect(msg).toMatch(/winget install DenoLand\.Deno/);
  });

  it('says so when cookies were already used', () => {
    const msg = explainYtdlpError(bot, { youtube: true, cookies: 'firefox' });
    expect(msg).toMatch(/cookies de firefox/);
    expect(msg).not.toMatch(/PA_DOWNLOAD/);
  });

  it('maps a missing JavaScript runtime to deno', () => {
    expect(explainYtdlpError('WARNING: No supported JavaScript runtime could be found')).toMatch(
      /deno/,
    );
    expect(explainYtdlpError('ERROR: n challenge solving failed')).toMatch(/deno/);
  });

  it('maps a format error on YouTube without deno to deno, not to "unavailable"', () => {
    const msg = explainYtdlpError('ERROR: Requested format is not available', {
      youtube: true,
      deno: false,
    });
    expect(msg).toMatch(/deno/);
    expect(msg).not.toMatch(/ya no está disponible/);
  });

  it('a loose "not available" no longer means the video is gone', () => {
    expect(explainYtdlpError('ERROR: Requested format is not available')).not.toMatch(
      /ya no está disponible/,
    );
    expect(explainYtdlpError('ERROR: Video unavailable')).toMatch(/ya no está disponible/);
  });

  it('reports a cookie-store failure as that, not as a login problem', () => {
    const msg = explainYtdlpError('ERROR: Could not copy Chrome cookie database.', {
      cookies: 'chrome',
    });
    expect(msg).toMatch(/no pude leer las cookies de chrome/);
    expect(msg).toMatch(/Firefox/);
  });

  it('still maps an ordinary private video', () => {
    expect(explainYtdlpError('ERROR: Private video. Sign in if you have access')).toMatch(
      /privado/,
    );
  });
});

describe.skipIf(!posix)('downloadVideo with a fake yt-dlp', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-fakeyt-'));
  const log = join(root, 'args.log');
  const script = join(root, 'yt-dlp');

  function install(opts: { impersonate: boolean; failFirstImpersonated?: boolean }) {
    writeFileSync(
      script,
      `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "--list-impersonate-targets" ]; then
  if [ "${opts.impersonate}" = "true" ]; then echo "Chrome - curl_cffi"; else echo "Chrome - curl_cffi (unavailable)"; fi
  exit 0
fi
if [ "${opts.failFirstImpersonated ?? false}" = "true" ] && [[ "$*" == *--impersonate* ]]; then
  echo "ERROR: Impersonate target chrome is not available" >&2; exit 1
fi
out=""
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done
f="\${out/%.%(ext)s/.mp4}"
printf 'x' > "$f"
printf '%s\\n' "Titulo" "12" "$f"
`,
    );
    chmodSync(script, 0o755);
    writeFileSync(log, '');
    resetDownloadCachesForTests();
  }
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('adds --impersonate chrome when yt-dlp can, and the browser cookies when configured', async () => {
    install({ impersonate: true });
    const r = await downloadVideo('https://example.org/v', script, {
      cookiesFromBrowser: 'firefox',
    });
    expect(r.ok).toBe(true);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toMatch(/--impersonate chrome/);
    expect(calls).toMatch(/--cookies-from-browser firefox/);
  });

  it('leaves both out by default and when impersonation is unavailable', async () => {
    install({ impersonate: false });
    const r = await downloadVideo('https://example.org/v', script);
    expect(r.ok).toBe(true);
    const calls = readFileSync(log, 'utf8');
    expect(calls).not.toMatch(/--impersonate chrome/);
    expect(calls).not.toMatch(/--cookies-from-browser/);
  });

  it('ignores a cookie browser that is not on the allowed list', async () => {
    install({ impersonate: false });
    await downloadVideo('https://example.org/v', script, { cookiesFromBrowser: 'rm -rf /' });
    expect(readFileSync(log, 'utf8')).not.toMatch(/--cookies-from-browser/);
  });

  it('retries without impersonation when the backend breaks', async () => {
    install({ impersonate: true, failFirstImpersonated: true });
    const r = await downloadVideo('https://example.org/v', script);
    expect(r.ok).toBe(true);
    const downloads = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.includes('--no-playlist'));
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).not.toMatch(/--impersonate/);
  });
});

describe('config: download cookies', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetConfigForTests();
  });

  it('is off by default, accepts a known browser and rejects a typo', () => {
    delete process.env.PA_DOWNLOAD_COOKIES_BROWSER;
    resetConfigForTests();
    expect(loadConfig().downloadCookiesBrowser).toBe('');
    process.env.PA_DOWNLOAD_COOKIES_BROWSER = 'Firefox';
    resetConfigForTests();
    expect(loadConfig().downloadCookiesBrowser).toBe('firefox');
    process.env.PA_DOWNLOAD_COOKIES_BROWSER = 'firefx';
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/PA_DOWNLOAD_COOKIES_BROWSER/);
  });
});

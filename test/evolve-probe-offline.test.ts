import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { playwrightBrowsersPath } from '../src/evolve/browsers-path.js';
import { measure } from '../src/evolve/measure.js';

// La sonda de extremo a extremo no arrancaba nunca: con la casa desechable de measure()
// Playwright buscaba los navegadores dentro de ella (no están), y `npx tsx` no es una
// dependencia, así que npx lo bajaba de internet en cada medición. Sin sonda, la base no se
// podía medir y ninguna semana empezaba.

describe('navegadores de Playwright', () => {
  it('donde los busca Playwright para el usuario de verdad', () => {
    expect(playwrightBrowsersPath({ HOME: '/home/n' }, 'linux')).toBe(
      '/home/n/.cache/ms-playwright',
    );
    expect(playwrightBrowsersPath({ HOME: '/home/n', XDG_CACHE_HOME: '/c' }, 'linux')).toBe(
      '/c/ms-playwright',
    );
    expect(playwrightBrowsersPath({ HOME: '/Users/n' }, 'darwin')).toBe(
      '/Users/n/Library/Caches/ms-playwright',
    );
    expect(playwrightBrowsersPath({ LOCALAPPDATA: 'C:\\U\\n\\AppData\\Local' }, 'win32')).toBe(
      'C:\\U\\n\\AppData\\Local\\ms-playwright',
    );
    expect(playwrightBrowsersPath({ USERPROFILE: 'C:\\U\\n' }, 'win32')).toBe(
      'C:\\U\\n\\AppData\\Local\\ms-playwright',
    );
    expect(playwrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '/b', HOME: '/h' }, 'linux')).toBe(
      '/b',
    );
  });
});

describe.skipIf(process.platform === 'win32')('la sonda no se descarga nada', () => {
  const dirs: string[] = [];
  const oldPath = process.env.PATH;
  const oldBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  afterEach(() => {
    process.env.PATH = oldPath;
    process.env.PLAYWRIGHT_BROWSERS_PATH = oldBrowsers;
    if (oldBrowsers === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  it('corre con lo instalado (vite-node, --no-install), no con `npx tsx`', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'evolve-npx-'));
    const cwd = mkdtempSync(join(tmpdir(), 'evolve-cwd-'));
    dirs.push(bin, cwd);
    writeFileSync(
      join(bin, 'npx'),
      [
        '#!/bin/sh',
        '[ "$1" = vitest ] && exit 0',
        'echo "$@" > probe-args.txt',
        "echo 'PASA uno'; echo; echo 'FLUJO GENERICO OK'; exit 0",
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'npx'), 0o755);
    process.env.PATH = `${bin}${delimiter}${oldPath}`;
    await measure({ cwd });
    const args = readFileSync(join(cwd, 'probe-args.txt'), 'utf8').trim().split(' ');
    expect(args).toEqual(['--no-install', 'vite-node', 'evolve/probe-generic-flow.ts']);
  });
  it.skipIf(process.platform !== 'linux')(
    'con la casa desechable la sonda encuentra los navegadores, y siguen ahí después',
    async () => {
      const bin = mkdtempSync(join(tmpdir(), 'evolve-npx-'));
      const cwd = mkdtempSync(join(tmpdir(), 'evolve-cwd-'));
      const browsers = mkdtempSync(join(tmpdir(), 'evolve-browsers-'));
      dirs.push(bin, cwd, browsers);
      writeFileSync(join(browsers, 'marca'), 'x');
      process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
      writeFileSync(
        join(bin, 'npx'),
        [
          '#!/bin/sh',
          '[ "$1" = vitest ] && exit 0',
          '[ -f "$HOME/.cache/ms-playwright/marca" ] && echo si > probe-browsers.txt',
          `env | grep -qF '${browsers}' && echo fuga > probe-env.txt`,
          "echo 'PASA uno'; echo; echo 'FLUJO GENERICO OK'; exit 0",
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, 'npx'), 0o755);
      process.env.PATH = `${bin}${delimiter}${oldPath}`;
      await measure({ cwd });
      expect(existsSync(join(cwd, 'probe-browsers.txt'))).toBe(true);
      expect(existsSync(join(cwd, 'probe-env.txt'))).toBe(false);
      expect(existsSync(join(browsers, 'marca'))).toBe(true);
    },
  );
});

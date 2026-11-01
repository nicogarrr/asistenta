import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/evolve/measure.js';

// npm lee su config global de <prefijo de Node>/etc/npmrc, fuera del HOME. En un Node
// instalado por el usuario (nvm en Linux/mac) el intento puede escribirla, y un
// node-options ahí cargaba código en el `npx vitest` de la medición (comprobado con npm
// real en una copia de Node, 31 oct). La medición la apunta a la casa desechable.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('la medición no lee la config global de npm', () => {
  it('cleanEnv apunta la config global y la de usuario de npm a la casa desechable', () => {
    const home = join(tmpdir(), 'h');
    const env = cleanEnv({ PATH: '/bin', HOME: '/home/real' }, home);
    expect(env.npm_config_globalconfig?.startsWith(home)).toBe(true);
    expect(env.npm_config_userconfig?.startsWith(home)).toBe(true);
  });

  it('el npm real usa esa config global, no la de la instalación de Node', () => {
    const home = mkdtempSync(join(tmpdir(), 'evo-npmrc-'));
    dirs.push(home);
    const win = process.platform === 'win32';
    const out = execFileSync(win ? 'npm.cmd' : 'npm', ['config', 'get', 'globalconfig'], {
      cwd: home,
      env: cleanEnv(process.env, home),
      shell: win,
      encoding: 'utf8',
      timeout: 60_000,
    }).trim();
    expect(out.startsWith(home)).toBe(true);
  }, 70_000);
});

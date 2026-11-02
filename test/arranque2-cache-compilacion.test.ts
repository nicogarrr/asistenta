import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startCompileCache } from '../src/envfile.js';

// `pa` arranca ~25 % antes con la caché de compilación de Node. Con ESM, la
// caché solo cubre lo que se carga DESPUÉS de activarla, así que la entrada es
// dist/pa.js: mínima (solo envfile.js estático) y el resto por import().

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

describe('caché de compilación: guardas', () => {
  it('se activa en la carpeta de Node y nunca rompe el arranque', () => {
    const enable = vi.fn();
    startCompileCache(enable);
    expect(enable).toHaveBeenCalledWith();
    const boom = () => {
      throw new Error('EACCES');
    };
    expect(() => startCompileCache(boom)).not.toThrow();
    // Node sin enableCompileCache: no hace nada.
    expect(() => startCompileCache(undefined)).not.toThrow();
  });
});

describe('dist/pa.js es la entrada de pa, del arranque con Windows y de levantar.bat', () => {
  it('src/pa.ts: solo envfile.js estático; Asistenta llega por import() y runCli', () => {
    const src = read('src/pa.ts');
    const estaticos = src.split('\n').filter((l) => /^import\s/.test(l));
    expect(estaticos).toEqual(["import './envfile.js';"]);
    expect(src).toContain("await import('./cli.js')");
    expect(src).toContain('runCli(process.argv.slice(2))');
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('package.json: el comando pa y npm start usan dist/pa.js', () => {
    const pkg = JSON.parse(read('package.json')) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.bin.pa).toBe('./dist/pa.js');
    expect(pkg.scripts.start).toBe('node dist/pa.js');
  });

  it('run-hidden.ps1 (tarea de inicio de Windows): dist\\pa.js y, si falta, dist\\cli.js', () => {
    const ps = read('deploy/windows/run-hidden.ps1');
    const pa = ps.indexOf("$cli = Join-Path $repo 'dist\\pa.js'");
    const respaldo = ps.indexOf(
      "if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { $cli = Join-Path $repo 'dist\\cli.js' }",
    );
    expect(pa).toBeGreaterThan(-1);
    expect(respaldo).toBeGreaterThan(pa);
    expect(ps).toContain(`$info.Arguments = '"' + $cli + '" serve'`);
  });

  it('levantar.bat: arranca con dist\\pa.js y, si falta, con dist\\cli.js', () => {
    const bat = read('levantar.bat');
    expect(bat).toMatch(
      /set "PA_JS=dist\\cli\.js"\r\nif exist dist\\pa\.js set "PA_JS=dist\\pa\.js"\r\n"%NODE_EXE%" %PA_JS% iniciar/,
    );
  });
});

describe.runIf(existsSync(resolve('dist/pa.js')) && process.platform !== 'win32')(
  'dist/pa.js compilado',
  () => {
    const run = (entry: string, stateDir: string, tmp: string) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PA_STATE_DIR: stateDir,
        PA_DESKTOP: 'off',
        TMPDIR: tmp,
      };
      delete env.FORCE_COLOR;
      delete env.NO_COLOR;
      delete env.NODE_COMPILE_CACHE;
      delete env.NODE_DISABLE_COMPILE_CACHE;
      return spawnSync(process.execPath, [resolve(entry), 'status'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: 60_000,
        env,
      });
    };

    it('hace lo mismo que dist/cli.js, deja la caché en la carpeta temporal y no escribe estado', () => {
      const root = mkdtempSync(join(tmpdir(), 'pa-cache-'));
      const state = join(root, 'estado');
      const tmp = join(root, 'tmp');
      mkdirSync(tmp);
      try {
        const a = run('dist/cli.js', state, tmp);
        const b = run('dist/pa.js', state, tmp);
        expect(b.status).toBe(a.status);
        expect(b.stdout).toBe(a.stdout);
        expect(b.stdout).toMatch(/Asistenta/);
        expect(existsSync(state)).toBe(false);
        expect(readdirSync(join(tmp, 'node-compile-cache')).length).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);

    it('si la carpeta de la caché no se puede crear, arranca igual', () => {
      const root = mkdtempSync(join(tmpdir(), 'pa-cache-ro-'));
      const tmp = join(root, 'tmp');
      mkdirSync(tmp);
      writeFileSync(join(tmp, 'node-compile-cache'), 'no soy una carpeta');
      try {
        const a = run('dist/cli.js', join(root, 'estado'), tmp);
        const b = run('dist/pa.js', join(root, 'estado'), tmp);
        expect(b.status).toBe(a.status);
        expect(b.stdout).toBe(a.stdout);
        expect(b.stderr).not.toMatch(/Error|ENOTDIR|EEXIST/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);

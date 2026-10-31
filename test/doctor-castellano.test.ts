import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// `pa doctor` es lo primero que ejecuta alguien que instala Asistenta por
// primera vez: lo que diga de cada pieza tiene que entenderse en castellano.
it.skipIf(process.platform !== 'linux')(
  'pa doctor dice en castellano qué falta y qué está bien',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-doctor-es-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' };
      for (const k of Object.keys(env)) if (/API_KEY$|^PA_CRON$|^PA_VERIFY/.test(k)) delete env[k];
      const r = spawnSync(process.execPath, [resolve('dist/cli.js'), 'doctor'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20000,
        env,
      });
      const out = r.stdout + r.stderr;
      expect(r.status).toBe(0);
      expect(out).toMatch(/^provider key +sin poner \(/m);
      expect(out).toMatch(/^carpeta +\S/m);
      expect(out).toMatch(/^node +v\d+/m);
      expect(out).toMatch(/^cron +0 tarea\(s\) programada\(s\) en PA_CRON$/m);
      expect(out).toMatch(/^verify actions +(activado \(2 capturas extra|desactivado)/m);
      expect(out).toMatch(/^browser +(chromium instalado|FALTA \(ejecuta: npx playwright)/m);
      expect(out).toMatch(
        /^vault +(creado|FALTA \(doble clic en instalar\.bat, o pa vault init\))$/m,
      );
      for (const ingles of [
        'unset (',
        'MISSING',
        'schedule(s)',
        'extra screenshots',
        'present',
        'run: ',
      ])
        expect(out).not.toContain(ingles);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

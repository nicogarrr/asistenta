import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliFatalMessage, unknownCommandMessage } from '../src/cli-messages.js';

// Primeros pasos en la consola de Windows: escribir solo `pa` sin la clave del
// modelo, o equivocarse de orden, tiene que dar una frase clara en castellano.
describe('pa en la consola: mensajes de primer uso', () => {
  it('la clave que falta se explica en castellano; otros errores no cambian', () => {
    const sinClave = new Error('no API key: run `pa vault set provider:apiKey <key>` or set X');
    expect(cliFatalMessage(sinClave)).toMatch(/^Falta la clave del proveedor/);
    expect(cliFatalMessage(new Error('no Gemini API key'))).toMatch(/^Falta la clave de Gemini/);
    expect(cliFatalMessage(new Error('Asistenta ya está en marcha'))).toBe(
      'Asistenta ya está en marcha',
    );
    expect(unknownCommandMessage('ayudame')).toBe(
      'No conozco la orden «ayudame». Para ver todas: pa --help (o pa ayuda)\n',
    );
  });

  it.skipIf(process.platform !== 'linux')(
    '`pa` sin clave, una orden mal escrita y `pa ayuda`',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pa-primer-uso-'));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' };
        for (const k of Object.keys(env)) if (/API_KEY$/.test(k)) delete env[k];
        const pa = (...args: string[]) =>
          spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {
            cwd: dir,
            encoding: 'utf8',
            timeout: 90_000,
            env,
            input: '',
          });
        const chat = pa('chat');
        expect(chat.stderr).toMatch(/Falta la clave del proveedor/);
        expect(chat.stderr).not.toMatch(/no API key|run `pa/);

        const mal = pa('versiom');
        expect(mal.status).toBe(2);
        expect(mal.stderr).toBe(
          'No conozco la orden «versiom». Para ver todas: pa --help (o pa ayuda)\n',
        );

        const ayuda = pa('ayuda');
        expect(ayuda.status).toBe(0);
        expect(ayuda.stdout).toMatch(/pa setup/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

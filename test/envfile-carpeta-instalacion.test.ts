import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dotEnvFiles, loadDotEnv } from '../src/envfile.js';

// Primer uso: `pa doctor` lanzado desde otra carpeta (la de usuario, el escritorio)
// no leía el .env de la instalación y decía que faltaban el token del bot o el del
// panel aunque estuvieran puestos.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function instalacion() {
  const root = mkdtempSync(join(tmpdir(), 'pa-envdir-'));
  dirs.push(root);
  const app = join(root, 'app');
  const otra = join(root, 'otra');
  mkdirSync(join(app, 'dist'), { recursive: true });
  mkdirSync(otra);
  return { app, otra, moduleUrl: pathToFileURL(join(app, 'dist', 'envfile.js')).href };
}

describe('.env de la instalación desde otra carpeta', () => {
  it('lee el de la carpeta actual y luego el de la instalación', () => {
    const { app, otra, moduleUrl } = instalacion();
    expect(dotEnvFiles(otra, moduleUrl)).toEqual([join(otra, '.env'), join(app, '.env')]);
  });

  it('en la carpeta de la instalación lo lee una sola vez', () => {
    const { app, moduleUrl } = instalacion();
    expect(dotEnvFiles(app, moduleUrl)).toEqual([join(app, '.env')]);
  });

  it('el de la carpeta actual gana y el de la instalación completa lo que falta', () => {
    const { app, otra, moduleUrl } = instalacion();
    writeFileSync(join(app, '.env'), 'PA_WEB_TOKEN=de-la-instalacion\nPA_WEB_PORT=8787\n');
    writeFileSync(join(otra, '.env'), 'PA_WEB_TOKEN=de-aqui\n');
    const env: NodeJS.ProcessEnv = {};
    for (const f of dotEnvFiles(otra, moduleUrl)) loadDotEnv(f, env);
    expect(env.PA_WEB_TOKEN).toBe('de-aqui');
    expect(env.PA_WEB_PORT).toBe('8787');
  });

  it('sin .env en la carpeta actual usa el de la instalación, sin avisos', () => {
    const { app, otra, moduleUrl } = instalacion();
    writeFileSync(join(app, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n');
    const env: NodeJS.ProcessEnv = {};
    for (const f of dotEnvFiles(otra, moduleUrl)) loadDotEnv(f, env);
    expect(env.TELEGRAM_BOT_TOKEN).toBe('123:abc');
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/envfile.js';

// Un .env guardado en Windows con el Bloc de notas o PowerShell 5 lleva BOM o va en UTF-16.
const dir = mkdtempSync(join(tmpdir(), 'envfile-bom-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lines = 'PA_TELEGRAM_OWNER=123\r\nPA_LOG_LEVEL=info\r\n';
function load(name: string, bytes: Buffer): NodeJS.ProcessEnv {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  const env: NodeJS.ProcessEnv = {};
  loadDotEnv(file, env);
  return env;
}

describe('.env de Windows', () => {
  it('UTF-8 con BOM: la primera variable no se pierde', () => {
    const env = load('bom8', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines)]));
    expect(env).toEqual({ PA_TELEGRAM_OWNER: '123', PA_LOG_LEVEL: 'info' });
  });

  it('UTF-16 (PowerShell 5 con «>»): se lee entero', () => {
    const env = load(
      'u16',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines, 'utf16le')]),
    );
    expect(env).toEqual({ PA_TELEGRAM_OWNER: '123', PA_LOG_LEVEL: 'info' });
  });

  it('sin BOM sigue igual y no pisa lo que ya está en el entorno', () => {
    const file = join(dir, 'plain');
    writeFileSync(file, lines);
    const env: NodeJS.ProcessEnv = { PA_LOG_LEVEL: 'debug' };
    loadDotEnv(file, env);
    expect(env).toEqual({ PA_TELEGRAM_OWNER: '123', PA_LOG_LEVEL: 'debug' });
  });

  it('si el archivo no existe no hace nada', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(join(dir, 'no-existe'), env);
    expect(env).toEqual({});
  });
});

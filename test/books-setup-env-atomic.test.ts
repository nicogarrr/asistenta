import type * as realFs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fail = vi.hoisted(() => ({ on: '' as string }));
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (
      path: realFs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      opts?: realFs.WriteFileOptions,
    ) => {
      if (fail.on && typeof path === 'string' && path.startsWith(fail.on)) {
        // Escribe la mitad y falla, como un disco lleno a mitad de escritura.
        fs.writeFileSync(path, String(data).slice(0, 5), opts);
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return fs.writeFileSync(path, data, opts);
    },
  };
});

const { saveCredsToEnv } = await import('../src/books/setup-page.js');

const ID = '123456';
const HASH = 'a'.repeat(32);
let dir: string;
let env: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-books-env-'));
  env = join(dir, '.env');
  fail.on = '';
});
afterEach(() => {
  fail.on = '';
  rmSync(dir, { recursive: true, force: true });
});

describe('libros: guardar las claves de Telegram en el .env', () => {
  it('un fallo a mitad de escritura no trunca el .env (que guarda todas las claves)', () => {
    const original = 'TELEGRAM_BOT_TOKEN=123:abc\nOPENAI_API_KEY=sk-xyz\n';
    writeFileSync(env, original);
    fail.on = env;
    expect(() => saveCredsToEnv(ID, HASH, env)).toThrow(/ENOSPC/);
    expect(readFileSync(env, 'utf8')).toBe(original);
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  it('respeta las líneas en blanco y los comentarios del resto del fichero', () => {
    writeFileSync(env, '# Telegram\nTELEGRAM_BOT_TOKEN=1\n\n# Modelo\nPA_MODEL=x\n');
    saveCredsToEnv(ID, HASH, env);
    expect(readFileSync(env, 'utf8')).toBe(
      `# Telegram\nTELEGRAM_BOT_TOKEN=1\n\n# Modelo\nPA_MODEL=x\nBOOKS_TG_API_ID=${ID}\nBOOKS_TG_API_HASH=${HASH}\n`,
    );
  });

  it('un .env de Windows (CRLF) sigue en CRLF', () => {
    writeFileSync(env, 'A=1\r\nBOOKS_TG_API_ID=999\r\n');
    saveCredsToEnv(ID, HASH, env);
    expect(readFileSync(env, 'utf8')).toBe(
      `A=1\r\nBOOKS_TG_API_ID=${ID}\r\nBOOKS_TG_API_HASH=${HASH}\r\n`,
    );
  });

  it('una clave repetida (o con export) no sigue mandando con el valor viejo', () => {
    writeFileSync(env, 'export BOOKS_TG_API_ID=1\nX=2\nBOOKS_TG_API_ID=2\n');
    saveCredsToEnv(ID, HASH, env);
    const out = readFileSync(env, 'utf8');
    expect(out.match(/BOOKS_TG_API_ID=/g)).toHaveLength(1);
    expect(out).toContain(`BOOKS_TG_API_ID=${ID}`);
    expect(out).toContain('X=2');
  });

  it.skipIf(process.platform === 'win32')('queda con permisos 0600', () => {
    writeFileSync(env, 'A=1\n', { mode: 0o644 });
    saveCredsToEnv(ID, HASH, env);
    expect(statSync(env).mode & 0o777).toBe(0o600);
  });
});

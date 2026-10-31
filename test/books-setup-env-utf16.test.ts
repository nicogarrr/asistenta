import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';

// PowerShell 5 (`echo X=1 > .env`) guarda el .env en UTF-16 con BOM. El
// arranque ya lo lee (#1148), pero el setup de libros lo leía como utf8 y, al
// guardar las claves, lo reescribía corrupto: se perdían TODAS las claves.
const { saveCredsToEnv } = await import('../src/books/setup-page.js');
const { envFileText } = await import('../src/envfile.js');

let dir: string;
let env: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-books-utf16-'));
  env = join(dir, '.env');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keys = () => parseEnv(envFileText(readFileSync(env)));

it('un .env en UTF-16 conserva sus claves y no duplica la que ya estaba', () => {
  const txt = 'TELEGRAM_BOT_TOKEN=123:abc\r\nBOOKS_TG_API_ID=1\r\n';
  writeFileSync(env, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(txt, 'utf16le')]));
  saveCredsToEnv('999', 'h'.repeat(32), env);
  expect(keys()).toEqual({
    TELEGRAM_BOT_TOKEN: '123:abc',
    BOOKS_TG_API_ID: '999',
    BOOKS_TG_API_HASH: 'h'.repeat(32),
  });
  expect(readFileSync(env, 'utf8').match(/BOOKS_TG_API_ID=/g)).toHaveLength(1);
});

it('un .env UTF-8 con BOM (Bloc de notas) reemplaza la primera clave en su sitio', () => {
  writeFileSync(env, '\uFEFFBOOKS_TG_API_ID=1\r\nOPENAI_API_KEY=sk-x\r\n');
  saveCredsToEnv('7', 'k'.repeat(32), env);
  const out = readFileSync(env, 'utf8');
  expect(out.match(/BOOKS_TG_API_ID=/g)).toHaveLength(1);
  expect(keys()).toMatchObject({ BOOKS_TG_API_ID: '7', OPENAI_API_KEY: 'sk-x' });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// Un usuario de Windows que no puede abrir su .env (bloqueado, sin permiso,
// o «.env» creado como carpeta) debe leer el aviso en castellano llano, sin
// el texto técnico en inglés del sistema.
const { envReadWarning, loadDotEnv } = await import('../src/envfile.js');

afterEach(() => vi.restoreAllMocks());

it('si .env no se puede leer, el aviso sale en castellano y sin texto técnico', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envfile-aviso-'));
  const writes: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    writes.push(String(s));
    return true;
  });
  try {
    loadDotEnv(dir, {}); // una carpeta: EISDIR
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const out = writes.join('');
  expect(out).toMatch(/^Aviso: «\.env» es una carpeta/);
  expect(out).not.toMatch(/could not be read|illegal operation|EISDIR/);
});

it('cada causa habitual tiene su frase, y lo desconocido no filtra el mensaje en inglés', () => {
  const e = (code: string) => Object.assign(new Error(`${code}: raw english`), { code });
  expect(envReadWarning(e('EBUSY'))).toMatch(/bloqueado por otro programa/);
  expect(envReadWarning(e('EACCES'))).toMatch(/no tengo permiso/);
  expect(envReadWarning(e('EPERM'))).toMatch(/no tengo permiso/);
  expect(envReadWarning(e('EIO'))).toBe(
    'Aviso: no pude leer el archivo .env (EIO). Arranco sin él.\n',
  );
  expect(envReadWarning(new Error('bad line'))).toMatch(/CLAVE=valor/);
  for (const c of ['EBUSY', 'EACCES', 'EIO'])
    expect(envReadWarning(e(c))).not.toMatch(/raw english/);
});

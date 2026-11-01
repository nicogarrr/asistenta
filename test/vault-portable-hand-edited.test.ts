import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPortableMap } from '../src/vault.js';

// secrets.json se prepara a mano (README). En Windows, el Bloc de notas puede guardarlo con
// BOM, y un fallo de sintaxis hacía que el error de JSON.parse citara el archivo: con las
// claves dentro.
function file(text: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'portable-')), 'secrets.json');
  writeFileSync(f, text, 'utf8');
  chmodSync(f, 0o600);
  return f;
}

describe('secrets.json escrito a mano', () => {
  it('con BOM del Bloc de notas se lee igual', () => {
    const f = file('\uFEFF{"telegram:token": "123:abc"}');
    expect(loadPortableMap({}, f)['telegram:token']).toBe('123:abc');
  });

  it('con un fallo de sintaxis avisa en castellano y nunca cita las claves', () => {
    const f = file('{"provider:openrouterKey": sk-or-SECRETO-123}');
    let message = '';
    try {
      loadPortableMap({}, f);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('no es un JSON válido');
    expect(message).not.toContain('SECRETO');
    expect(message).not.toContain('sk-or');
  });
});

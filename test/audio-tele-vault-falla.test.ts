import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tvCasterFromVault } from '../src/audio/tv-cast.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

// Tele falsa: nunca hay red real. El caster es dueño del fichero desde que se le
// pasa; si no llega a mandarlo a la tele, tiene que borrarlo él.
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-tvcast-vault-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tvCasterFromVault: si leer el emparejamiento falla, no deja la copia del audio', () => {
  for (const key of ['tv:host', 'tv:clientKey', 'tv:secure', 'tv:glasshouseUrl']) {
    it(`falla al leer ${key}: borra el fichero y avisa del error`, async () => {
      const file = join(dir, 'a.mp3');
      writeFileSync(file, 'x');
      const vault: Record<string, string> = { 'tv:host': '192.168.1.50', 'tv:clientKey': 'K' };
      const vaultGet = async (k: string): Promise<string | null> => {
        if (k === key) throw new Error('almacén bloqueado');
        return vault[k] ?? null;
      };
      const request = vi.fn(async () => ({}));
      const serve = vi.fn();
      const cast = tvCasterFromVault(vaultGet, request as never, {
        pickAddress: () => '192.168.1.10',
        serve: serve as never,
      });
      await expect(cast(file)).rejects.toThrow('almacén bloqueado');
      expect(existsSync(file)).toBe(false);
      expect(request).not.toHaveBeenCalled();
      expect(serve).not.toHaveBeenCalled();
    });
  }
});

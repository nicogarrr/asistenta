import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Latidos, latidoListRequest } from '../src/daemon/latido.js';

/** «¿Qué estás vigilando?» iba al modelo; ahora la lista sale al momento. */
describe('«¿qué estás vigilando?»', () => {
  it.each([
    '¿Qué estás vigilando?',
    'que estas vigilando ahora',
    '¿y qué vigilas?',
    '¿Estás vigilando algo?',
    'qué sigues vigilando',
  ])('%s', (said) => {
    expect(latidoListRequest(said)).toBe(true);
  });

  it('otras frases no', () => {
    expect(latidoListRequest('vigila la web')).toBe(false);
    expect(latidoListRequest('¿qué estás haciendo?')).toBe(false);
  });

  it('lista los de todos los hilos de ese chat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag3-latido-lista-'));
    try {
      const latidos = new Latidos({
        run: async () => 'SIN_CAMBIOS',
        send: async () => {},
        isBusy: () => false,
        file: join(dir, 'latidos.json'),
        later: () => ({ cancel: () => {} }),
      });
      latidos.start('telegram:1#main', '1', 'mira si vuelve internet');
      latidos.start('telegram:1#trabajo', '1', 'mira la web del banco', 15);
      latidos.start('telegram:2#main', '2', 'otro chat');
      expect(latidos.listInChat('telegram:1').map((l) => l.task)).toEqual([
        'mira si vuelve internet',
        'mira la web del banco',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

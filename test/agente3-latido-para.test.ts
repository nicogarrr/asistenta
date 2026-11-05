import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Latidos, latidoStopRequest } from '../src/daemon/latido.js';

/**
 * «Deja de vigilar» pasaba por el modelo (un turno entero, y a veces no llamaba a la
 * herramienta). Ahora se reconoce y se para al momento lo de ese chat.
 */
describe('«deja de vigilar»', () => {
  it.each([
    ['deja de vigilar', ''],
    ['Para de vigilar.', ''],
    ['ya no hace falta que vigiles', ''],
    ['no vigiles más', ''],
    ['para el latido', ''],
    ['deja de vigilar lo de la web', 'la web'],
    ['para de vigilar el router', 'router'],
    ['dejar de vigilarlo', ''],
  ])('%s → «%s»', (said, needle) => {
    expect(latidoStopRequest(said)).toBe(needle);
  });

  it('lo que no es eso → null', () => {
    expect(latidoStopRequest('vigila la web cada 10 min')).toBeNull();
    expect(latidoStopRequest('¿qué estás vigilando?')).toBeNull();
    expect(latidoStopRequest('para')).toBeNull();
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('para los de todos los hilos de ese chat y no los de otro chat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag3-latido-para-'));
    dirs.push(dir);
    const latidos = new Latidos({
      run: async () => 'SIN_CAMBIOS',
      send: async () => {},
      isBusy: () => false,
      file: join(dir, 'latidos.json'),
      later: () => ({ cancel: () => {} }),
    });
    latidos.start('telegram:1#main', '1', 'mira si vuelve internet');
    latidos.start('telegram:1#trabajo', '1', 'mira la web del banco');
    latidos.start('telegram:2#main', '2', 'mira si vuelve internet');
    expect(latidos.stopInChat('telegram:1', 'web').map((l) => l.task)).toEqual([
      'mira la web del banco',
    ]);
    expect(latidos.stopInChat('telegram:1').map((l) => l.task)).toEqual([
      'mira si vuelve internet',
    ]);
    expect(latidos.list('telegram:2#main')).toHaveLength(1);
  });
});

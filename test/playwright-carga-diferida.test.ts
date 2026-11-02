import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    return statSync(ruta).isDirectory() ? archivos(ruta) : ruta.endsWith('.ts') ? [ruta] : [];
  });
}

describe('arranque: playwright se carga solo al abrir el navegador', () => {
  it('ningún archivo de src importa playwright como valor al arrancar (solo tipos)', () => {
    const culpables = archivos('src').filter((ruta) =>
      /^import\s+(?!type\b)[^;]*from\s+'playwright'/m.test(readFileSync(ruta, 'utf8')),
    );
    expect(culpables).toEqual([]);
  });
});

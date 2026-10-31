import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Si npm ci falla a medias (o se borra node_modules, como aconseja el instalador),
// dist\cli.js sigue ahí y levantar.bat arrancaba Node, que soltaba
// ERR_MODULE_NOT_FOUND en inglés. Ahora lo para antes y manda a instalar.bat.
const bat = readFileSync(new URL('../levantar.bat', import.meta.url), 'utf8');

describe('levantar.bat con la instalación a medias', () => {
  it('comprueba que npm terminó (node_modules\\.package-lock.json) antes de arrancar', () => {
    const check = bat.indexOf('if not exist node_modules\\.package-lock.json');
    expect(check).toBeGreaterThan(bat.indexOf('if not exist dist\\cli.js'));
    expect(check).toBeLessThan(bat.indexOf('dist\\cli.js iniciar'));
  });

  it('dice qué hacer en castellano y deja la ventana abierta', () => {
    const bloque = bat.slice(bat.indexOf('if not exist node_modules'));
    expect(bloque.slice(0, bloque.indexOf('exit /b 1'))).toContain('instalar.bat');
    expect(bloque).toMatch(/incompleta[\s\S]*pause\r?\n\s*exit \/b 1/);
  });
});

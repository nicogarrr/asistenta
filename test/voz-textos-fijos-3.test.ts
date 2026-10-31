import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nico (31 oct): que Asistenta hable como en un chat. Más textos fijos que llegan
// tal cual, sin pasar por el modelo: sin «turnos», «daemon» ni identificadores.
const cli = readFileSync('src/cli.ts', 'utf8');
const restore = readFileSync('src/backup-restore.ts', 'utf8');
const panel = readFileSync('src/webui/page.ts', 'utf8');

describe('textos fijos sin jerga (3)', () => {
  it('/exportar: el pie del archivo no cuenta «turnos»', () => {
    expect(cli).toContain('`Aquí tienes la conversación «');
    expect(cli).not.toMatch(/turns\.length\} turnos/);
  });

  it('/perfil guardar: sin el identificador interno', () => {
    expect(cli).toContain("await say(inbound, 'Guardado en tu perfil.', { quote: true });");
    expect(cli).not.toContain('Guardado en tu perfil (');
  });

  it('/skills instalar: sin el identificador interno', () => {
    expect(cli).toContain('`Hecho, ya tengo la skill «');
    expect(cli).not.toContain('`Skill instalada: ');
  });

  it('pa restaurar con Asistenta en marcha: sin «daemon»', () => {
    expect(restore).toContain('Asistenta está en marcha. Párala con «pa stop» y vuelve a probar.');
    expect(restore).not.toMatch(/para el daemon/);
  });

  it('panel: las capturas no dicen «del turno»', () => {
    expect(panel).toContain("img.alt = 'Captura ' + (i + 1);");
    expect(panel).not.toContain("' del turno'");
  });
});

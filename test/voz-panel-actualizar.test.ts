import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nico (31 oct): que Asistenta hable como en un chat. El aviso de «Actualizar» del
// panel decía «Error al actualizar» o «2 secciones con error»: frases de máquina.
const panel = readFileSync('src/webui/page.ts', 'utf8');

describe('panel: aviso de actualizar en lenguaje natural', () => {
  it('fallo al actualizar: «No he podido actualizar»', () => {
    expect(panel).toContain("marca.textContent = 'No he podido actualizar';");
    expect(panel).not.toContain("'Error al actualizar'");
  });

  it('secciones que no cargan: «sin cargar», no «con error»', () => {
    expect(panel).toContain("' sección sin cargar · '");
    expect(panel).toContain("' secciones sin cargar · '");
    expect(panel).not.toContain("' con error · '");
  });

  it('sin token: frase entera', () => {
    expect(panel).toContain("marca.textContent = 'Falta el token';");
    expect(panel).not.toContain("'Sin token'");
  });
});

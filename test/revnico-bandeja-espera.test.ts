import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Revisión de #1876: Reanudar/Reiniciar esperan hasta 90 s al arranque real, pero
 * la espera corría con `Start-Sleep -Seconds 4` dentro del clic, en el hilo de la
 * interfaz: la bandeja quedaba congelada (menú, punto, «Salir») todo ese tiempo.
 */
const tray = readFileSync('scripts/windows-app/bandeja.ps1', 'utf8');
const fn = tray.slice(
  tray.indexOf('function Wait-Encendida'),
  tray.indexOf('\n}', tray.indexOf('function Wait-Encendida')),
);

describe('bandeja: la espera al arranque no congela la interfaz', () => {
  it('atiende los eventos de Windows mientras espera, sin dormir segundos seguidos', () => {
    expect(fn).toContain('[System.Windows.Forms.Application]::DoEvents()');
    expect(fn).not.toMatch(/Start-Sleep -Seconds/);
    expect(fn).toMatch(/Start-Sleep -Milliseconds 200/);
  });

  it('un segundo clic durante la espera no abre otra espera, y «Salir» la corta', () => {
    expect(fn).toMatch(/if \(\$script:esperando\) \{ return \$false \}/);
    expect(fn).toMatch(/finally \{ \$script:esperando = \$false \}/);
    expect(fn).toContain('$icono.Visible');
  });

  it('sigue esperando hasta 90 s y devolviendo si arrancó', () => {
    expect(fn).toContain('[int] $Segundos = 90');
    expect(fn).toMatch(/if \(\$script:enMarcha\) \{ return \$true \}/);
  });
});

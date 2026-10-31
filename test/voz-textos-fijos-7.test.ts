import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { doctorLineEs } from '../src/doctor-labels.js';

// Nico (31 oct): que Asistenta hable como en un chat. `pa doctor` sin «SAPI»,
// «bytes», «libx264», «pwsh», «(on)» ni «vault» como respuesta.
const cli = readFileSync('src/cli.ts', 'utf8');

describe('pa doctor sin jerga en los valores', () => {
  it('captura y vídeo de pantalla dicen «funciona», sin bytes ni códecs', () => {
    expect(cli).toMatch(/`screenshot {6}funciona \(\$\{shot\.width\}x\$\{shot\.height\}\)`/);
    expect(cli).toContain("ffmpegAvailable() ? 'funciona' :");
    expect(cli).not.toMatch(/bytes, \$\{shot\.width\}/);
    expect(cli).not.toContain('ffmpeg + libx264');
  });

  it('voz y palabra clave en castellano', () => {
    expect(cli).toContain("'voice tts       la voz de Windows (sin internet, gratis)'");
    expect(cli).not.toContain('windows SAPI');
    expect(cli).toContain("=== 'off' ? 'apagada' : 'encendida'");
  });

  it('consola y clave del modelo sin «pwsh» ni «vault» a secas', () => {
    expect(cli).toContain(
      "hasPwsh() ? 'PowerShell 7' : 'PowerShell 5.1 (funciona; con PowerShell 7 va mejor)'",
    );
    expect(cli).not.toContain('sintaxis completa');
    expect(cli).toContain(
      "keySrc.source === 'vault' ? 'guardada en tus claves' : 'puesta en el .env'",
    );
  });

  it('modo servidor: dice qué no mira, sin «chequeos»', () => {
    expect(cli).not.toContain('sin chequeos de escritorio');
    expect(
      doctorLineEs(
        'desktop         off (modo servidor, PA_DESKTOP=off): no miro pantalla, cámara ni micrófono',
      ),
    ).toBe(
      'escritorio      apagado (modo servidor, PA_DESKTOP=off): no miro pantalla, cámara ni micrófono',
    );
  });

  it('la línea de la palabra clave sigue traduciendo la etiqueta', () => {
    expect(doctorLineEs('wake word       «asistenta» (encendida)')).toBe(
      'palabra clave   «asistenta» (encendida)',
    );
  });
});

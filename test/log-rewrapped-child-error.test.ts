import { describe, expect, it } from 'vitest';
import { redact, scrubLogText, scrubLogValue } from '../src/log.js';

/**
 * Un error de execFile re-envuelto en otro Error (o copiado a un campo de texto) ya no
 * lleva `cmd`: solo queda el texto «Command failed: …». La orden puede ocupar varias
 * líneas (script de PowerShell) y stderr puede repetirla; nada de eso va al registro.
 */
const SCRIPT =
  "$t = 'Carta privada de Ana'\nGet-Process | Where-Object { $_.MainWindowTitle -eq $t }";
const MSG = `Command failed: powershell.exe -NoProfile -Command ${SCRIPT}\nAt line:2 char:1\n+ Get-Process | Where-Object { $_.MainWindowTitle -eq $t }\n`;

describe('registro: error de proceso hijo re-envuelto', () => {
  it('un Error nuevo con el mensaje copiado no deja líneas del script', () => {
    const out = JSON.stringify(redact({ err: new Error(`ventana: ${MSG}`) }));
    expect(out).not.toContain('Carta privada');
    expect(out).not.toContain('MainWindowTitle');
    expect(out).toContain('ventana: Command failed: [orden omitida]');
  });

  it('un campo de texto con el mensaje tampoco', () => {
    const out = JSON.stringify(redact({ error: MSG }));
    expect(out).not.toContain('Carta privada');
    expect(out).not.toContain('MainWindowTitle');
  });

  it('las líneas de stderr tras la orden se omiten', () => {
    expect(scrubLogValue(MSG)).toBe('Command failed: [orden omitida]');
  });

  it('un texto sin «Command failed» no cambia', () => {
    expect(scrubLogValue('línea uno\nlínea dos')).toBe('línea uno\nlínea dos');
  });

  it('scrubLogText (otros usos, p. ej. salida de herramientas) conserva las líneas siguientes', () => {
    expect(scrubLogText('Command failed: x\nresto')).toBe('Command failed: [orden omitida]\nresto');
  });
});

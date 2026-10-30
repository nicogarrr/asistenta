import { describe, expect, it } from 'vitest';
import { redact, scrubLogText } from '../src/log.js';

/**
 * Un error de execFile lleva la línea de órdenes entera en `message` (y en `cmd`):
 * scripts de PowerShell con títulos de ventana, texto del usuario o rutas. Al registro
 * no debe llegar por ningún `log.warn(…, { err })`.
 */
const SCRIPT = "Get-Process | Where-Object { $_.MainWindowTitle -eq 'Carta privada de Ana' }";
const CMD = `powershell.exe -NoProfile -Command ${SCRIPT}`;

function execError(): Error {
  const e = new Error(`Command failed: ${CMD}\nAt line:1 char:5 'Carta privada de Ana'\n`);
  Object.assign(e, {
    cmd: CMD,
    code: 1,
    killed: false,
    signal: null,
    stderr: "Error en 'Carta privada de Ana'\nmás",
  });
  return e;
}

describe('registro: errores de procesos hijos sin la línea de órdenes', () => {
  it('un Error de execFile no deja la orden ni el texto entrecomillado', () => {
    const out = JSON.stringify(redact({ err: execError() }));
    expect(out).not.toContain('Carta privada');
    expect(out).not.toContain('MainWindowTitle');
    expect(out).toContain('"code":1');
    expect(out).toContain('Command failed');
  });

  it('anidado en otros campos también', () => {
    const out = JSON.stringify(redact({ ctx: { errors: [execError()] } }));
    expect(out).not.toContain('Carta privada');
  });

  it('el mensaje copiado a texto pierde la orden', () => {
    const out = scrubLogText(`fallo: ${execError().message}`);
    expect(out).not.toContain('MainWindowTitle');
    expect(out).toContain('Command failed: [orden omitida]');
  });

  it('un Error normal conserva su mensaje', () => {
    const out = JSON.stringify(redact({ err: new Error('disco lleno') }));
    expect(out).toContain('disco lleno');
  });
});

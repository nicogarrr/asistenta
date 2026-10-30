import { describe, expect, it } from 'vitest';
import { redact } from '../src/log.js';

const SCRIPT = "Get-Process | Where-Object { $_.MainWindowTitle -eq 'Carta privada de Ana' }";
const CMD = `powershell.exe -NoProfile -Command ${SCRIPT}`;

describe('registro: objetos planos con la orden', () => {
  it('un campo cmd o command no deja la orden', () => {
    for (const key of ['cmd', 'command', 'commandLine']) {
      const out = JSON.stringify(redact({ info: { [key]: CMD, code: 1 } }));
      expect(out).not.toContain('Carta privada');
      expect(out).not.toContain('MainWindowTitle');
      expect(out).toContain('"code":1');
    }
  });

  it('el error copiado a un objeto ({ ...err }) no deja la orden ni la salida entera', () => {
    const copy = {
      cmd: CMD,
      code: 1,
      stdout: 'linea 1\nMainWindowTitle eco',
      stderr: "Error en 'Carta privada de Ana'\nAt line:1 MainWindowTitle",
    };
    const out = JSON.stringify(redact({ err: copy }));
    expect(out).not.toContain('Carta privada');
    expect(out).not.toContain('MainWindowTitle');
    expect(out).toContain('Error en');
  });

  it('objetos sin orden no cambian', () => {
    expect(redact({ a: { stdout: 'hola\nadiós', n: 2 } })).toEqual({
      a: { stdout: 'hola\nadiós', n: 2 },
    });
  });
});

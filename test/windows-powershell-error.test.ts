import { describe, expect, it } from 'vitest';
import { POWERSHELL_TIMEOUT_MS, powerShellError } from '../src/screen/windows.js';

/**
 * Error de PowerShell en Computer Use. Antes el mensaje era el de execFile:
 * «Command failed: powershell.exe … -Command <script entero>», más la línea que
 * PowerShell cita («+ …SendWait('texto')»): el texto que se estaba escribiendo y
 * kilobytes de C# acababan en el resultado que lee el modelo (y podía llegar al
 * chat). Ahora queda solo la frase de error de PowerShell, o «no respondió».
 */
const SCRIPT =
  "$ErrorActionPreference='Stop'\n[System.Windows.Forms.SendKeys]::SendWait('mi-clave-123')";

function execErr(over: Record<string, unknown>) {
  return Object.assign(
    new Error(`Command failed: powershell.exe -NoProfile -NonInteractive -Command ${SCRIPT}`),
    {
      code: 1,
      killed: false,
      signal: null,
      stdout: '',
      stderr: '',
      ...over,
    },
  );
}

describe('computer · errores de PowerShell sin el script', () => {
  it('se queda con la frase de error y corta antes de la línea citada', () => {
    const err = powerShellError(
      execErr({
        stderr:
          'Exception calling "SendWait" with "1" argument(s): "Access is denied."\r\nAt line:2 char:1\r\n+ [System.Windows.Forms.SendKeys]::SendWait(\'mi-clave-123\')\r\n+ ~~~~\r\n    + CategoryInfo : NotSpecified',
      }),
    );
    expect(err.message).toBe(
      'PowerShell falló (código 1): Exception calling "SendWait" with "1" argument(s): "Access is denied."',
    );
    expect(err.message).not.toContain('mi-clave-123');
    expect(err.message).not.toContain('Command failed');
  });

  it('el corte por tiempo se dice en español, sin script', () => {
    const err = powerShellError(execErr({ killed: true, signal: 'SIGTERM', code: null }));
    expect(err.message).toContain(`${POWERSHELL_TIMEOUT_MS / 1000} s`);
    expect(err.message).not.toContain('SendWait');
  });

  it('sin stderr no inventa ni filtra nada; mensajes largos se recortan', () => {
    expect(powerShellError(execErr({})).message).toBe(
      'PowerShell falló (código 1) sin mensaje de error.',
    );
    const long = powerShellError(execErr({ stderr: 'x'.repeat(1000) })).message;
    expect(long.length).toBeLessThan(340);
    expect(
      powerShellError(Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }))
        .message,
    ).toContain('No encuentro powershell.exe');
  });
});

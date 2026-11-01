import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
vi.mock('../src/log.js', async (orig) => {
  const real = await orig<typeof import('../src/log.js')>();
  return { ...real, log: { ...real.log, warn: (...a: unknown[]) => warn(...a) } };
});

const SCRIPT = "Get-Process | ? MainWindowTitle -eq 'Banco: saldo de Nico'";
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => {
      const err = Object.assign(new Error(`Command failed: powershell.exe -Command ${SCRIPT}`), {
        cmd: `powershell.exe -NoProfile -Command ${SCRIPT}`,
        code: 1,
        killed: false,
        stderr: "No existe la ventana 'Banco: saldo de Nico'\r\nAt line:1 char:5",
      });
      cb(err);
    },
  };
});

describe('el log de PowerShell no guarda la línea de órdenes', () => {
  afterEach(() => warn.mockClear());

  it('un fallo de listWindows registra código y stderr sin el script ni el título', async () => {
    const { listWindows } = await import('../src/tools/windows.js');
    await listWindows().catch(() => undefined);
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('saldo de Nico');
    expect(logged).not.toContain('MainWindowTitle');
    expect(logged).toContain('No existe la ventana');
  });

  it('psErrorSummary tapa lo entrecomillado y conserva el código', async () => {
    const { psErrorSummary } = await import('../src/tools/ps-error.js');
    const s = psErrorSummary({
      cmd: 'x',
      code: 2,
      stderr: '\n  Falta «mi carpeta privada» "otra"\n',
    });
    expect(s).toEqual({ code: 2, stderr: "Falta '…' '…'" });
    expect(psErrorSummary(new Error('sin cmd'))).toEqual({ message: 'sin cmd' });
  });

  it('windows.ts y system.ts no pasan el error crudo al log', () => {
    for (const f of ['src/tools/windows.ts', 'src/tools/system.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/log\.\w+\([^)]*\{\s*err\s*\}/);
    }
  });
});

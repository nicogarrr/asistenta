import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOSTART_NOT_WINDOWS, autostartCommand } from '../src/autostart.js';

const realPlatform = process.platform;
let err = '';
beforeEach(() => {
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err += String(s);
    return true;
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.restoreAllMocks();
});

describe('pa autostart fuera de Windows', () => {
  it.each(['linux', 'darwin'])('en %s dice qué usar en su lugar', async (plat) => {
    Object.defineProperty(process, 'platform', { value: plat });
    expect(await autostartCommand(['install'])).toBe(2);
    expect(err).toBe(`${AUTOSTART_NOT_WINDOWS}\n`);
    expect(err).toContain('pa serve');
    expect(err).toContain('docker compose');
    expect(err.trim().split('\n')).toHaveLength(1);
  });

  it('el aviso del navegador sin preparar evita el bloqueo de PowerShell', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/autostart.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain(
      'powershell -ExecutionPolicy Bypass -File deploy\\\\browserd\\\\setup-browserd.ps1',
    );
  });
});

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ProcesoHid } from '../src/iphone/ble.js';

// Solo en Windows (el job de Windows de CI): el ayudante Bluetooth del iPhone compila con el
// csc.exe que trae Windows contra sus APIs WinRT, arranca y contesta por su protocolo. Un
// runner de CI no tiene Bluetooth: se espera que lo diga (periferico=false con motivo), no
// que publique nada.
const enWindows = process.platform === 'win32';
const run = promisify(execFile);

describe.skipIf(!enWindows)('ayudante Bluetooth del iPhone en Windows de verdad', () => {
  const base = enWindows ? mkdtempSync(join(tmpdir(), 'asis-hid-')) : '';
  const exe = join(base, 'Asistenta', 'iphone', 'AsistentaHid.exe');
  const script = resolve('deploy/iphone/windows/compilar-hid.ps1');
  const env = { ...process.env, LOCALAPPDATA: base };
  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('compila con el csc de Windows y la segunda vez no recompila', async () => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
    const a = await run('powershell.exe', args, { env, timeout: 180_000 });
    expect(a.stdout).toMatch(/Compilado/);
    expect(existsSync(exe)).toBe(true);
    const b = await run('powershell.exe', args, { env, timeout: 60_000 });
    expect(b.stdout).toMatch(/Ya compilado/);
  }, 240_000);

  it('arranca, contesta al estado y, sin radio que sirva, lo dice y no manda nada', async () => {
    const proc = new ProcesoHid(() =>
      spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    try {
      const e = await proc.pedir({ op: 'estado' }, 30_000);
      expect(e.ok).toBe(true);
      expect(typeof e.periferico).toBe('boolean');
      if (e.periferico !== true) {
        expect(String(e.problema)).toMatch(/Bluetooth/);
        const r = await proc.pedir(
          { op: 'enviar', pasos: [{ r: 3, d: 'AAAAAAA=', ms: 0 }] },
          30_000,
        );
        expect(r.ok).toBe(false);
        expect(r.enviados).toBe(0);
      }
    } finally {
      proc.cerrar();
    }
  }, 60_000);
});

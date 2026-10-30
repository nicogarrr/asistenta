import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autostartCommand } from '../src/autostart.js';
import { iniciarCommand } from '../src/iniciar.js';
import type { PreflightCheck, PreflightDeps } from '../src/preflight.js';
import {
  formatStartupRecord,
  readStartupRecord,
  STARTUP_RECORD_FILE,
  saveStartupRecord,
} from '../src/startup-record.js';
import { STATE_ENTRIES } from '../src/state-files.js';

vi.mock('node:child_process', () => ({
  execFile: (_exe: string, _flags: string[], _opts: unknown, cb: (...a: unknown[]) => void) =>
    cb(null, 'Tarea: OK\n', ''),
}));

vi.mock('../src/preflight.js', async (orig) => ({
  ...(await orig<typeof import('../src/preflight.js')>()),
  runPreflight: async () => [
    { id: 'node', label: 'Node', status: 'ok', detail: '' },
    { id: 'disco', label: 'Disco', status: 'fallo', detail: '' },
  ],
}));

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'startup-record-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const check = (label: string, status: PreflightCheck['status']): PreflightCheck => ({
  id: label,
  label,
  status,
  detail: '',
});
const NOW = new Date('2026-10-30T15:00:00Z');

describe('última comprobación de arranque', () => {
  it('guarda en verde/rojo con las etiquetas, y lo relee', () => {
    const path = join(tmp(), STARTUP_RECORD_FILE);
    saveStartupRecord(
      path,
      [check('Node', 'ok'), check('Token de Telegram', 'fallo'), check('Correo', 'aviso')],
      NOW,
    );
    expect(readStartupRecord(path)).toEqual({
      at: NOW.toISOString(),
      ok: false,
      fallos: ['Token de Telegram'],
      avisos: ['Correo'],
    });
  });

  it('la línea dice cuándo y qué falló, en español', () => {
    const later = new Date(NOW.getTime() + 5 * 60_000);
    expect(
      formatStartupRecord({ at: NOW.toISOString(), ok: true, fallos: [], avisos: [] }, later),
    ).toBe('Última comprobación de arranque (pa iniciar), hace 5 min: todo en verde ✅.');
    const bad = formatStartupRecord(
      { at: NOW.toISOString(), ok: false, fallos: ['Disco', 'Vault'], avisos: ['Correo'] },
      new Date(NOW.getTime() + 3 * 3_600_000),
    );
    expect(bad).toContain('hace 3 h: ❌ 2 fallos: Disco, Vault; 1 aviso: Correo.');
    expect(bad).toContain('pa iniciar --solo-comprobar');
    expect(formatStartupRecord(undefined)).toContain('ninguna guardada todavía');
  });

  it('un fichero roto o raro cuenta como «ninguna», sin lanzar', () => {
    const path = join(tmp(), STARTUP_RECORD_FILE);
    writeFileSync(path, '{roto');
    expect(readStartupRecord(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ at: 'ayer', ok: true, fallos: [], avisos: [] }));
    expect(readStartupRecord(path)).toBeUndefined();
    expect(readStartupRecord(join(tmp(), 'no-existe.json'))).toBeUndefined();
  });

  it('no poder guardarlo nunca rompe el arranque', () => {
    const blocker = join(tmp(), 'soy-un-fichero');
    writeFileSync(blocker, 'x');
    expect(() => saveStartupRecord(join(blocker, 'dentro', 'x.json'), [], NOW)).not.toThrow();
  });

  it('pa iniciar --solo-comprobar lo guarda donde la CLI le dice', async () => {
    const path = join(tmp(), STARTUP_RECORD_FILE);
    const deps = {} as PreflightDeps;
    const code = await iniciarCommand(['--solo-comprobar'], {
      deps: async () => deps,
      serve: async () => 0,
      write: () => undefined,
      writeErr: () => undefined,
      color: false,
      recordPath: path,
    });
    expect(code).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ ok: false, fallos: ['Disco'] });
  });

  it('pa autostart status enseña la última comprobación', async () => {
    const dir = tmp();
    saveStartupRecord(join(dir, STARTUP_RECORD_FILE), [check('Node', 'ok')], new Date());
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await autostartCommand(['status'], { stateDir: dir });
    expect(out.join('')).toContain('todo en verde ✅');
    expect(out.join('')).toContain('Tarea: OK');
  });

  it('install y un uso incorrecto no la enseñan (solo status)', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await autostartCommand(['install'], { stateDir: tmp() });
    await autostartCommand(['status', '--raro'], { stateDir: tmp() });
    expect(out.join('')).not.toContain('Última comprobación');
  });

  it('el fichero está registrado en el directorio de estado', () => {
    expect(STATE_ENTRIES.some((e) => e.name === STARTUP_RECORD_FILE)).toBe(true);
  });
});

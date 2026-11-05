import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// bugs30: «dime los controles de configuracion» (sin tilde) no llegaba a la ventana
// «Configuración»: el filtro de PowerShell (-like y el nombre exacto de UIA) distingue
// tildes. Ahora la ventana se elige antes con pickWindow y se entra por su handle.
const scripts: string[] = [];
const reply = vi.fn((_script: string): string => '');

vi.mock('node:child_process', () => {
  const run = (script: string) => {
    scripts.push(script);
    return { stdout: reply(script), stderr: '' };
  };
  const execFile = Object.assign(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (e: null, out: string, err: string) => void,
    ) => {
      const r = run(args[args.length - 1] ?? '');
      cb(null, r.stdout, r.stderr);
    },
    {
      [promisify.custom]: (_cmd: string, args: string[]) =>
        Promise.resolve(run(args[args.length - 1] ?? '')),
    },
  );
  return { execFile, execFileSync: vi.fn(), spawn: vi.fn() };
});

const { listControls } = await import('../src/tools/windows.js');

describe('controles de una ventana sin tildes o por programa (bugs30)', () => {
  beforeEach(() => {
    scripts.length = 0;
    reply.mockImplementation((script: string) => {
      if (script.includes('GetForegroundWindow')) return '4321';
      if (script.includes('MainWindowTitle -replace')) {
        return [
          'SystemSettings|111|655370|Configuración',
          'Spotify|222|655380|Rosalía - DESPECHÁ',
          'Code|4321|655390|cli.ts - asistenta',
        ].join('\n');
      }
      if (script.includes('UIAutomationClient')) return 'FOUND|Configuración|655370\nVISIBLE|0\n';
      return '';
    });
  });

  it('«configuracion» entra por el handle de «Configuración» y la busca con su título exacto', async () => {
    const res = await listControls('configuracion');
    const uia = scripts.find((s) => s.includes('UIAutomationClient')) ?? '';
    expect(uia).toContain('$PA_TARGET_HANDLE = 655370');
    expect(uia).toContain("-like ('*Configuración*')");
    expect(uia).toContain('$PA_FOREGROUND_PID = 4321');
    expect(res.window).toBe('Configuración');
  });

  it('«spotify» (la ventana se titula con la canción) entra por la de Spotify', async () => {
    await listControls('spotify');
    const uia = scripts.find((s) => s.includes('UIAutomationClient')) ?? '';
    expect(uia).toContain('$PA_TARGET_HANDLE = 655380');
  });

  it('sin coincidencia, el filtro de siempre; sin match, la ventana enfocada', async () => {
    await listControls('telegram');
    let uia = scripts.find((s) => s.includes('UIAutomationClient')) ?? '';
    expect(uia).toContain('$PA_TARGET_HANDLE = 0');
    expect(uia).toContain("-like ('*telegram*')");
    scripts.length = 0;
    await listControls();
    uia = scripts.find((s) => s.includes('UIAutomationClient')) ?? '';
    expect(uia).toContain('$PA_TARGET_HANDLE = 0');
    expect(scripts.some((s) => s.includes('MainWindowTitle -replace'))).toBe(false);
  });
});

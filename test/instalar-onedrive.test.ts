import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { enOneDrive, instalar } from '../scripts/instalar.mjs';

// Carpeta dentro de OneDrive: OneDrive bloquea archivos mientras sincroniza y
// `npm ci` falla con EPERM. El instalador lo avisa claro y dice adónde moverla.
const ONEDRIVE = 'C:\\Users\\Ana\\OneDrive\\Escritorio\\asistenta';

function deps(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const d = {
    nodeVersion: 'v24.3.0',
    cwd: 'C:\\Asistenta',
    env: {},
    write: (s: string) => out.push(s),
    run: vi.fn(async () => 0),
    exists: () => false,
    copy: vi.fn(),
    readEnv: () => '',
    cli: vi.fn(async () => 1),
    vaultList: async () => null,
    vaultSet: vi.fn(async () => 0),
    ask: vi.fn(async () => ''),
    fetch: vi.fn(),
    ...over,
  };
  return { d, text: () => out.join('') };
}

describe('instalador dentro de OneDrive', () => {
  it('reconoce la carpeta de OneDrive por la variable de Windows o por el nombre', () => {
    expect(enOneDrive(ONEDRIVE, {})).toBe(true);
    expect(enOneDrive('D:\\Nube\\asistenta', { OneDrive: 'D:\\Nube' })).toBe(true);
    expect(
      enOneDrive('C:\\Users\\ana\\OneDrive - Empresa SL\\asistenta', {
        OneDriveCommercial: 'C:\\Users\\Ana\\OneDrive - Empresa SL',
      }),
    ).toBe(true);
    expect(enOneDrive('C:\\Users\\Ana\\OneDrive - Empresa SL\\x', {})).toBe(true);
    expect(enOneDrive('C:\\Asistenta', { OneDrive: 'C:\\Users\\Ana\\OneDrive' })).toBe(false);
    expect(enOneDrive('C:\\Users\\Ana\\OneDriveViejo\\a', {})).toBe(false);
    expect(enOneDrive('D:\\Nube2\\a', { OneDrive: 'D:\\Nube' })).toBe(false);
    expect(enOneDrive('/home/ana/asistenta', {})).toBe(false);
    expect(enOneDrive(undefined, undefined)).toBe(false);
  });

  it('avisa antes de instalar y, si npm ci falla, dice que la mueva a C:\\Asistenta', async () => {
    const { d, text } = deps({ cwd: ONEDRIVE, run: vi.fn(async () => 1) });
    expect(await instalar(d)).toBe(1);
    expect(text()).toContain('⚠ Asistenta está dentro de OneDrive');
    expect(text()).toContain('OneDrive tenía archivos bloqueados');
    expect(text()).toContain('C:\\Asistenta');
    expect(text()).not.toContain('Mira tu conexión a internet');
  });

  it('si falla la compilación dentro de OneDrive, el mismo consejo', async () => {
    const run = vi.fn(async (_c: string, a: string[]) => (a[0] === 'run' ? 1 : 0));
    const { d, text } = deps({ cwd: ONEDRIVE, run });
    expect(await instalar(d)).toBe(1);
    expect(text()).toContain('No se ha podido compilar: OneDrive tenía archivos bloqueados');
  });

  it('fuera de OneDrive no avisa, y el fallo de npm ci explica EPERM (antivirus, editor)', async () => {
    const { d, text } = deps({ run: vi.fn(async () => 1) });
    expect(await instalar(d)).toBe(1);
    expect(text()).not.toContain('OneDrive');
    expect(text()).toContain('EPERM');
    expect(text()).toContain('antivirus');
  });
});

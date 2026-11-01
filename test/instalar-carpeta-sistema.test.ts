import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { enCarpetaSistema, instalar } from '../scripts/instalar.mjs';
import { enCarpetaSistema as enSistemaDoctor, installDoctorLines } from '../src/doctor-install.js';

// Asistenta descomprimida en «Archivos de programa»: sin administrador Windows no deja
// escribir ahí y `npm ci` falla con EPERM. El instalador y `pa doctor` lo dicen claro.
const PF = 'C:\\Program Files\\Asistenta';
const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };

function deps(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const d = {
    nodeVersion: 'v24.3.0',
    cwd: 'C:\\Asistenta',
    env,
    write: (s: string) => out.push(s),
    run: vi.fn(async () => 1),
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

describe('Asistenta en una carpeta del sistema', () => {
  it('reconoce Archivos de programa y Windows, también sin variables', () => {
    for (const f of [enCarpetaSistema, enSistemaDoctor]) {
      expect(f(PF, env)).toBe(true);
      expect(f('C:\\Program Files (x86)\\a', env)).toBe(true);
      expect(f('D:\\Programas\\a', { ProgramFiles: 'D:\\Programas' })).toBe(true);
      expect(f('c:/program files/asistenta', {})).toBe(true);
      expect(f('C:\\Windows\\System32\\a', {})).toBe(true);
      expect(f('C:\\Asistenta', env)).toBe(false);
      expect(f('C:\\Users\\Ana\\Program Files Mios\\a', env)).toBe(false);
      expect(f('C:\\Program Files Mios\\a', {})).toBe(false);
      expect(f('', env)).toBe(false);
    }
  });

  it('el instalador avisa antes y, si npm ci falla, dice que la mueva a C:\\Asistenta', async () => {
    const { d, text } = deps({ cwd: PF });
    expect(await instalar(d)).toBe(1);
    expect(text()).toContain('⚠ Asistenta está en una carpeta del sistema');
    expect(text()).toContain('Windows no deja escribir en esta carpeta del sistema');
    expect(text()).toContain('C:\\Asistenta');
    expect(text()).not.toContain('Mira tu conexión a internet');
  });

  it('en una carpeta normal no dice nada de esto', async () => {
    const { d, text } = deps();
    expect(await instalar(d)).toBe(1);
    expect(text()).not.toContain('carpeta del sistema');
  });

  it('pa doctor: la línea «carpeta» lo dice', () => {
    const [, carpeta] = installDoctorLines({ dir: PF, env, nodeVersion: 'v24.1.0' });
    expect(carpeta).toMatch(/^carpeta +C:\\Program Files\\Asistenta — es una carpeta del sistema/);
    expect(carpeta).toContain('C:\\Asistenta');
  });
});

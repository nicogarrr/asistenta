import { describe, expect, it } from 'vitest';
import { enOneDrive, installDoctorLines } from '../src/doctor-install.js';

// `pa doctor` avisa de dos trampas de un PC nuevo con Windows: la carpeta en
// OneDrive (EPERM al instalar/actualizar) y un Node más viejo que 24.
describe('pa doctor: carpeta y Node', () => {
  it('carpeta dentro de OneDrive → dice que la mueva a C:\\Asistenta', () => {
    const [, carpeta] = installDoctorLines({
      dir: 'C:\\Users\\Ana\\OneDrive\\Documentos\\asistenta',
      env: { OneDrive: 'C:\\Users\\Ana\\OneDrive' },
      nodeVersion: 'v24.1.0',
    });
    expect(carpeta).toMatch(
      /^carpeta +C:\\Users\\Ana\\OneDrive\\Documentos\\asistenta — está dentro de OneDrive/,
    );
    expect(carpeta).toContain('C:\\Asistenta');
  });

  it('carpeta normal → solo la ruta', () => {
    const lines = installDoctorLines({
      dir: 'C:\\Asistenta',
      env: { OneDrive: 'C:\\Users\\Ana\\OneDrive' },
      nodeVersion: 'v24.1.0',
    });
    expect(lines).toEqual(['node            v24.1.0', 'carpeta         C:\\Asistenta']);
  });

  it('Node 22 → lo dice claro y dónde bajarlo', () => {
    const [node] = installDoctorLines({ dir: '/opt/a', env: {}, nodeVersion: 'v22.9.0' });
    expect(node).toMatch(/^node +v22\.9\.0 — DEMASIADO VIEJO: hace falta Node 24/);
    expect(node).toContain('https://nodejs.org');
  });

  it('reconoce OneDrive de empresa y no confunde nombres parecidos', () => {
    expect(enOneDrive('C:\\Users\\a\\OneDrive - Empresa\\x', {})).toBe(true);
    expect(enOneDrive('C:\\Users\\a\\OneDriveViejo\\x', {})).toBe(false);
    expect(enOneDrive('D:\\Nube2\\x', { OneDrive: 'D:\\Nube' })).toBe(false);
    expect(enOneDrive('', {})).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { pickWindow, type WindowInfo } from '../src/tools/windows.js';

// bugs29: «pon delante configuracion» (escrito sin tilde) no encontraba «Configuración», y
// «activa spotify» no encontraba Spotify porque su ventana se titula con la canción.
describe('activar ventana sin tildes o por programa (bugs29)', () => {
  const w = (title: string, process: string, pid: number): WindowInfo => ({
    title,
    process,
    pid,
    handle: pid,
    focused: false,
  });
  const windows = [
    w('Configuración', 'SystemSettings', 1),
    w('Rosalía - DESPECHÁ', 'Spotify', 2),
    w('Facturación 2026.xlsx - Excel', 'EXCEL', 3),
    w('Bandeja de entrada - Outlook', 'olk', 4),
  ];
  it('sin tildes a un lado o al otro', () => {
    expect(pickWindow(windows, 'configuracion')?.pid).toBe(1);
    expect(pickWindow(windows, 'Facturacion 2026')?.pid).toBe(3);
    expect(pickWindow(windows, 'despecha')?.pid).toBe(2);
  });
  it('por nombre de programa cuando el título no lo dice', () => {
    expect(pickWindow(windows, 'Spotify')?.pid).toBe(2);
    expect(pickWindow(windows, 'excel.exe')?.pid).toBe(3);
  });
  it('lo de siempre: título exacto primero, nada si no hay', () => {
    const two = [w('Notas', 'notepad', 7), w('Notas de clase - Word', 'WINWORD', 8)];
    expect(pickWindow(two, 'notas')?.pid).toBe(7);
    expect(pickWindow(windows, 'telegram')).toBeUndefined();
    expect(pickWindow(windows, '  ')).toBeUndefined();
  });
});

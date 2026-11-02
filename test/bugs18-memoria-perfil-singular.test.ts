import { describe, expect, it } from 'vitest';
import { memoryExportCaption, profileMigratedText } from '../src/cli-messages.js';

// asis-bugs-18: «Memoria de este chat (1 entradas)» y «Migrados 1 hechos del perfil antiguo».
describe('memoria y perfil: singular con 1', () => {
  it('el pie del fichero de /memoria exportar', () => {
    expect(memoryExportCaption(1)).toBe('Memoria de este chat (1 entrada)');
    expect(memoryExportCaption(3)).toBe('Memoria de este chat (3 entradas)');
    expect(memoryExportCaption(0)).toBe('Memoria de este chat (0 entradas)');
  });

  it('/perfil migrar', () => {
    expect(profileMigratedText(1)).toBe('Migrado 1 hecho del perfil antiguo.');
    expect(profileMigratedText(4)).toBe('Migrados 4 hechos del perfil antiguo.');
    expect(profileMigratedText(0)).toBe('Migrados 0 hechos del perfil antiguo.');
  });
});

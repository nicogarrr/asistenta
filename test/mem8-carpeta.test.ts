// asis-memoria-8: la memoria vive en una carpeta legible del PC (perfil,
// episodios diarios, procedimientos, notas e índice), cada escritura al momento.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asegurarCarpetaMemoria,
  dentroDeCarpeta,
  registrarEpisodio,
  resumenCarpetaMemoria,
  textoCarpetaMemoria,
} from '../src/memory/carpeta.js';
import { paths } from '../src/paths.js';

const nueva = (): string => join(mkdtempSync(join(tmpdir(), 'mem8-')), 'memoria');

describe('carpeta de memoria', () => {
  it('vive en la carpeta de datos de Asistenta, como memoria/', () => {
    expect(paths.memoria).toBe(join(paths.state, 'memoria'));
  });

  it('el primer arranque crea subcarpetas e índice', () => {
    const dir = nueva();
    asegurarCarpetaMemoria(dir);
    for (const sub of ['episodios', 'procedimientos', 'notas'])
      expect(existsSync(join(dir, sub))).toBe(true);
    expect(readFileSync(join(dir, 'indice.md'), 'utf8')).toContain('# Índice de memoria');
  });

  it('cada turno añade una línea al diario del día, al momento, y lo apunta en el índice', () => {
    const dir = nueva();
    asegurarCarpetaMemoria(dir);
    const fecha = new Date(2026, 10, 7, 10, 9);
    const f = registrarEpisodio(dir, {
      fecha,
      chat: 'telegram:1',
      pedido: 'hola\n¿qué tal?',
      respuesta: 'Bien',
    });
    registrarEpisodio(dir, { fecha, chat: 'telegram:1', pedido: 'otra', respuesta: 'vale' });
    expect(f).toBe(join(dir, 'episodios', '2026-11-07.md'));
    const txt = readFileSync(f as string, 'utf8');
    expect(txt.match(/^# Episodios 2026-11-07/gm)).toHaveLength(1);
    expect(txt).toContain('- 10:09 · telegram:1 · Tú: «hola ¿qué tal?» → Asistenta: «Bien»');
    expect(txt.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
    expect(readFileSync(join(dir, 'indice.md'), 'utf8')).toContain('episodios/2026-11-07.md');
  });

  it('nada que parezca una clave entra en el diario', () => {
    const dir = nueva();
    const f = registrarEpisodio(dir, {
      fecha: new Date(2026, 10, 7),
      chat: 'x',
      pedido: 'mi token es ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      respuesta: 'ok',
    });
    const txt = readFileSync(f as string, 'utf8');
    expect(txt).not.toContain('ghp_');
    expect(txt).toContain('[omitido');
  });

  it('/memoria dice la ruta y un resumen por tipo', () => {
    const dir = nueva();
    asegurarCarpetaMemoria(dir);
    registrarEpisodio(dir, {
      fecha: new Date(2026, 10, 7),
      chat: 'x',
      pedido: 'a',
      respuesta: 'b',
    });
    const txt = textoCarpetaMemoria(resumenCarpetaMemoria(dir));
    expect(txt).toContain(`📁 Carpeta de memoria: ${dir}`);
    expect(txt).toContain('episodios: 1 día(s), último 2026-11-07');
    expect(txt).toContain('procedimientos: 0');
  });

  it('/memoria en Telegram enseña la carpeta', () => {
    const cli = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const cmd = cli.slice(cli.indexOf('const cmdMemoria'), cli.indexOf("if (sub === 'buscar'"));
    expect(cmd.match(/carpetaMemoriaTexto\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(cli).toContain('registrarEpisodio(paths.memoria');
  });

  it('las rutas no salen de la carpeta', () => {
    expect(dentroDeCarpeta('/m', 'notas/a.md')).toBe(true);
    expect(dentroDeCarpeta('/m', '../fuera.md')).toBe(false);
    expect(dentroDeCarpeta('/m', '/etc/passwd')).toBe(false);
    expect(dentroDeCarpeta('/m', '')).toBe(false);
  });
});

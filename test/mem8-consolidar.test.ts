// asis-memoria-8: la pasada nocturna ordena los diarios sin perder líneas y lo
// último que pasó en el chat entra en la nota del turno.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archivarEpisodios,
  asegurarCarpetaMemoria,
  notaEpisodiosRecientes,
  registrarEpisodio,
} from '../src/memory/carpeta.js';

const nueva = (): string => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mem8c-')), 'memoria');
  asegurarCarpetaMemoria(dir);
  return dir;
};

describe('consolidación de episodios', () => {
  it('los diarios de hace más de 60 días pasan al archivo del mes, enteros', () => {
    const dir = nueva();
    registrarEpisodio(dir, {
      fecha: new Date(2026, 7, 1, 9),
      chat: 'c',
      pedido: 'agosto 1',
      respuesta: 'r',
    });
    registrarEpisodio(dir, {
      fecha: new Date(2026, 7, 2, 9),
      chat: 'c',
      pedido: 'agosto 2',
      respuesta: 'r',
    });
    registrarEpisodio(dir, {
      fecha: new Date(2026, 10, 6, 9),
      chat: 'c',
      pedido: 'ayer',
      respuesta: 'r',
    });
    const n = archivarEpisodios(dir, new Date(2026, 10, 7, 3));
    expect(n).toBe(2);
    const mes = readFileSync(join(dir, 'episodios', 'archivo', '2026-08.md'), 'utf8');
    expect(mes).toContain('# Episodios 2026-08-01');
    expect(mes).toContain('agosto 1');
    expect(mes).toContain('agosto 2');
    expect(existsSync(join(dir, 'episodios', '2026-08-01.md'))).toBe(false);
    expect(existsSync(join(dir, 'episodios', '2026-11-06.md'))).toBe(true);
    expect(readFileSync(join(dir, 'indice.md'), 'utf8')).toContain('episodios/archivo/2026-08.md');
    expect(archivarEpisodios(dir, new Date(2026, 10, 7, 3))).toBe(0);
  });

  it('la nota del turno trae lo último de ESTE chat (hoy y ayer), acotado', () => {
    const dir = nueva();
    registrarEpisodio(dir, {
      fecha: new Date(2026, 10, 6, 22),
      chat: 'tg:1',
      pedido: 'busca vuelos',
      respuesta: 'hecho',
    });
    registrarEpisodio(dir, {
      fecha: new Date(2026, 10, 7, 9),
      chat: 'tg:2',
      pedido: 'secreto de otro',
      respuesta: 'x',
    });
    for (let i = 0; i < 10; i++) {
      registrarEpisodio(dir, {
        fecha: new Date(2026, 10, 7, 10, i),
        chat: 'tg:1',
        pedido: `p${i}`,
        respuesta: 'ok',
      });
    }
    const nota = notaEpisodiosRecientes(dir, 'tg:1', new Date(2026, 10, 7, 11));
    expect(nota).toContain('Episodios recientes de este chat');
    expect(nota).toContain('p9');
    expect(nota).not.toContain('secreto de otro');
    expect(nota.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(6);
    expect(notaEpisodiosRecientes(dir, 'tg:3', new Date(2026, 10, 7, 11))).toBe('');
  });

  it('el turno la usa y la pasada nocturna archiva', () => {
    const cli = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(cli).toContain('episodiosDelTurno(thread.key)');
    expect(cli).toContain('archivarEpisodios(paths.memoria)');
  });
});

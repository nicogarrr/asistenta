import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bibliotecaOrden } from '../src/biblioteca.js';
import { buscarEnlaces, EnlacesFijados, enlacesDe, enlacesVista } from '../src/enlaces-enviados.js';
import { PaginasVivas, panelPaginas } from '../src/paginas-vivas.js';

const NOW = Date.UTC(2026, 10, 11, 18, 0);
const H = 3_600_000;
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps16-enlaces-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 30 respuestas con un enlace cada una: el de idealista es de hace 25 (fuera de los 10 últimos).
const turnos = Array.from({ length: 30 }, (_, i) => ({
  at: NOW - i * H,
  text:
    i === 25
      ? 'Mira [Piso en Gijón, 3 hab](https://www.idealista.com/inmueble/123/)'
      : `Noticia ${i}: https://www.expansion.com/mercados/${i}.html`,
}));

describe('gaps-16: «/biblioteca enlaces idealista» busca entre los enlaces', () => {
  it('la orden: «enlaces <texto>», sin romper «enlaces», «enlaces fijar 2» ni «enlaces 2»', () => {
    expect(bibliotecaOrden('enlaces idealista')).toEqual({ kind: 'enlaces', busca: 'idealista' });
    expect(bibliotecaOrden('enlaces del piso de Gijón')).toEqual({
      kind: 'enlaces',
      busca: 'piso de Gijón',
    });
    expect(bibliotecaOrden('enlaces')).toEqual({ kind: 'enlaces' });
    expect(bibliotecaOrden('enlaces fijar 2')).toMatchObject({ kind: 'enlace-pin', n: 2 });
    expect(bibliotecaOrden('enlaces 2')).not.toMatchObject({ kind: 'enlaces', busca: '2' });
  });

  it('encuentra uno más viejo que los 10 últimos, por etiqueta o dirección, sin tildes', () => {
    expect(enlacesDe(turnos).some((e) => e.url.includes('idealista'))).toBe(false);
    const todos = enlacesDe(turnos, 200);
    expect(buscarEnlaces(todos, 'idealista').map((e) => e.url)).toEqual([
      'https://www.idealista.com/inmueble/123/',
    ]);
    expect(buscarEnlaces(todos, 'piso gijon')).toHaveLength(1);
    expect(buscarEnlaces(todos, 'piso madrid')).toHaveLength(0);
    expect(buscarEnlaces(todos, 'expansion')).toHaveLength(29);
  });

  it('la vista dice qué buscó, y si no hay nada, cómo verlos todos', () => {
    const r = buscarEnlaces(enlacesDe(turnos, 200), 'idealista');
    const v = enlacesVista(r, NOW, 'Europe/Madrid', [], 'idealista');
    expect(v.text).toMatch(/^🔗 Enlaces con «idealista» \(1\):/);
    expect(v.text).toContain('Piso en Gijón, 3 hab');
    expect(v.pins).toHaveLength(1);
    const nada = enlacesVista([], NOW, 'Europe/Madrid', [], 'zzz');
    expect(nada.text).toContain('No encuentro ningún enlace con «zzz»');
    // Sin búsqueda, la lista normal enseña cómo buscar.
    expect(enlacesVista(enlacesDe(turnos), NOW, 'Europe/Madrid').text).toContain(
      '«/biblioteca enlaces <palabra>»',
    );
  });

  it('cli: con búsqueda mira más atrás que los 10 últimos', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('.buscarEnlaces(en.enlacesDe(turnos, en.ENLACES_BUSCA_MAX), busca)');
  });
});

describe('gaps-16: los enlaces fijados, en la tarjeta Páginas del panel', () => {
  it('todos() junta los de sus chats sin repetir; el panel solo enseña https', () => {
    const f = new EnlacesFijados(join(dir, 'enlaces-fijados.json'));
    f.fijar('telegram:1:', {
      url: 'https://www.idealista.com/inmueble/123/',
      etiqueta: 'Piso',
      at: NOW,
    });
    f.fijar('telegram:2:', {
      url: 'https://idealista.com/inmueble/123',
      etiqueta: 'Piso',
      at: NOW - H,
    });
    f.fijar('telegram:1:', {
      url: 'http://inseguro.example/x',
      etiqueta: 'Viejo',
      at: NOW - 2 * H,
    });
    expect(f.todos()).toHaveLength(2);
    const store = new PaginasVivas(new DatabaseSync(':memory:'));
    const p = panelPaginas(store, join(dir, 'salidas'), 'Europe/Madrid', undefined, () =>
      f.todos(),
    );
    expect(p.enlaces).toEqual([
      expect.objectContaining({
        url: 'https://www.idealista.com/inmueble/123/',
        etiqueta: 'Piso',
        dominio: 'idealista.com',
      }),
    ]);
    // Sin la dependencia (o sin fijados), nada.
    expect(panelPaginas(store, join(dir, 'salidas'), 'Europe/Madrid').enlaces).toEqual([]);
  });

  it('la página los pinta como enlaces que se abren aparte', () => {
    const page = readFileSync(join(__dirname, '..', 'src', 'webui', 'page.ts'), 'utf8');
    expect(page).toContain("a.rel = 'noopener noreferrer';");
    expect(page).toContain('Array.isArray(datos.enlaces)');
  });
});

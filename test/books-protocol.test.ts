import { describe, expect, it } from 'vitest';
import { parseBookCard, parseSearchResults, sanitizeQuery } from '../src/books/protocol.js';

// Texto real de la captura de Nico (11-oct-2026), con saltos de linea feos incluidos.
const SEARCH_REPLY = `Ahí van algunos libros que coinciden con tu búsqueda:
El enigma Quijote /bJ3eE
El Quijote como juego /bN62E
Curso sobre el Quijote /bWeaE
Quijote en el Congo /b4ciE
El Quijote de Wellesley /
bdU7y2
El japonés del Quijote /
bQaZa3
El regreso de Don Quijote /
bk11E
Viaje alrededor de El Quijote /bi46E
Don Quijote en el exilio /bnv7E
Cuatro ensayos sobre el Quijote /b6V6y2`;

const CARD_REPLY = `Don Quijote en el exilio - Peter Fürst
Publicado: 1994 | 386 páginas
Crónica Memorias
«Fui "concebido" en el Café Románico de Berlín, y luego me criaron en sus mesas de mármol...`;

describe('parseSearchResults', () => {
  it('extrae los 10 pares de la respuesta real, incluidos los partidos en dos lineas', () => {
    const hits = parseSearchResults(SEARCH_REPLY);
    expect(hits).toHaveLength(10);
    expect(hits[0]).toEqual({ title: 'El enigma Quijote', code: 'bJ3eE' });
    expect(hits[4]).toEqual({ title: 'El Quijote de Wellesley', code: 'bdU7y2' });
    expect(hits[8]).toEqual({ title: 'Don Quijote en el exilio', code: 'bnv7E' });
  });

  it('no confunde el encabezado del bot con un resultado', () => {
    const hits = parseSearchResults(SEARCH_REPLY);
    expect(hits.map((h) => h.title)).not.toContain(
      'Ahí van algunos libros que coinciden con tu búsqueda:',
    );
  });

  it('sin codigos devuelve lista vacia, nunca un resultado fantasma', () => {
    expect(parseSearchResults('No encuentro nada con ese nombre')).toEqual([]);
  });

  it('un codigo de longitud distinta no cuela', () => {
    expect(parseSearchResults('Libro raro /bJ3e')).toEqual([]);
    expect(parseSearchResults('Libro raro /bJ3eE7x')).toEqual([]);
  });

  it('dos codigos en una linea: el segundo titulo no arrastra el primero', () => {
    const hits = parseSearchResults('Libro Uno /b1111 Libro Dos /b2222');
    expect(hits).toEqual([
      { title: 'Libro Uno', code: 'b1111' },
      { title: 'Libro Dos', code: 'b2222' },
    ]);
  });

  it('el codigo conserva mayusculas y minusculas (son significativas)', () => {
    const hit = parseSearchResults('Don Quijote en el exilio /bnv7E')[0];
    expect(hit?.code).toBe('bnv7E');
  });
});

describe('parseBookCard', () => {
  it('parsea la ficha real completa', () => {
    const card = parseBookCard(CARD_REPLY);
    expect(card).toEqual({
      title: 'Don Quijote en el exilio',
      author: 'Peter Fürst',
      year: 1994,
      pages: 386,
      genre: 'Crónica Memorias',
    });
  });

  it('sin autor (sin guion) no inventa autor', () => {
    const card = parseBookCard('El Quijote\nPublicado: 1605 | 863 páginas\nNovela');
    expect(card?.title).toBe('El Quijote');
    expect(card?.author).toBeUndefined();
  });

  it('sin linea Publicado no inventa año ni paginas', () => {
    const card = parseBookCard('Ensayo raro - Alguien\nEnsayo');
    expect(card?.year).toBeUndefined();
    expect(card?.pages).toBeUndefined();
  });

  it('texto vacio devuelve undefined, nunca title ""', () => {
    expect(parseBookCard('')).toBeUndefined();
    expect(parseBookCard('   \n  ')).toBeUndefined();
  });

  it('una card sin cabecera no convierte "Publicado..." en titulo', () => {
    expect(parseBookCard('Publicado: 1994 | 386 páginas\nEnsayo')).toBeUndefined();
  });

  it('la cita inicial («...») nunca se cuela como genero', () => {
    const card = parseBookCard(CARD_REPLY);
    expect(card?.genre).not.toMatch(/^«/);
  });
});

describe('sanitizeQuery', () => {
  it('quita comandos y espacios', () => {
    expect(sanitizeQuery('/start  El  quijote ')).toBe('El quijote');
  });
  it('quita TODOS los comandos encadenados, no solo el primero', () => {
    expect(sanitizeQuery('/start /otro /b1234 quijote')).toBe('quijote');
  });
  it('rechaza la busqueda vacia', () => {
    expect(() => sanitizeQuery('   ')).toThrow(/vacia/);
    expect(() => sanitizeQuery('/bJ3eE')).toThrow(/vacia/);
  });
  it('corta entradas absurdamente largas', () => {
    expect(sanitizeQuery('x'.repeat(500))).toHaveLength(120);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buscarEnlaces,
  claveEnlace,
  ENLACES_BUSCA_MAX,
  enlaceParaFijar,
  enlacesDe,
  enlacesVista,
} from '../src/enlaces-enviados.js';

// bugs-38: «/biblioteca enlaces idealista» encuentra un enlace de hace 25 respuestas (fuera de los
// 10 últimos), pero su «📌 1» contestaba «no encuentro ese enlace»: el botón buscaba su clave
// solo entre los 10 últimos y los fijados. Buscar un enlace viejo es justo para fijarlo.
const NOW = Date.UTC(2026, 10, 11, 18, 0);
const H = 3_600_000;
const turnos = Array.from({ length: 30 }, (_, i) => ({
  at: NOW - i * H,
  text:
    i === 25
      ? 'Mira [Piso en Gijón, 3 hab](https://www.idealista.com/inmueble/123/)'
      : `Noticia ${i}: https://www.expansion.com/mercados/${i}.html`,
}));

describe('bugs-38: «📌 N» de una búsqueda de enlaces fija ese enlace aunque sea viejo', () => {
  it('el botón de la búsqueda lleva la clave del de idealista y se encuentra', () => {
    const hallados = buscarEnlaces(enlacesDe(turnos, ENLACES_BUSCA_MAX), 'idealista');
    const v = enlacesVista(hallados, NOW, 'Europe/Madrid', [], 'idealista');
    const pin = v.pins[0];
    const clave = claveEnlace('https://www.idealista.com/inmueble/123/');
    expect(pin).toMatchObject({ sub: 'fijarenlace', clave });
    const e = enlaceParaFijar(turnos, [], { n: 1, clave });
    expect(e?.url).toBe('https://www.idealista.com/inmueble/123/');
  });

  it('sin clave, «fijar N» sigue contando en la lista de siempre (los 10 últimos)', () => {
    expect(enlaceParaFijar(turnos, [], { n: 1 })?.url).toBe(
      'https://www.expansion.com/mercados/0.html',
    );
    expect(enlaceParaFijar(turnos, [], { n: 11 })).toBeNull();
    expect(enlaceParaFijar(turnos, [], { n: 1, clave: 'ffffffffff' })).toBeNull();
  });
});

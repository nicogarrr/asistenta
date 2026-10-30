import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/memory/sessions.js';

const filler = 'hablamos de muchas cosas del trabajo la casa la compra el coche y el banco hoy';

function store(): SessionStore {
  return new SessionStore({ db: new DatabaseSync(':memory:') });
}

describe('búsqueda de sesiones: cabecera y turnos en la misma escala', () => {
  it('una mención de pasada en un turno no gana a las sesiones tituladas con el término', () => {
    const s = store();
    const c = s.begin('chat', 'Compras');
    s.addTurn(c, 'user', `${filler} y de paso un amigo vuelve de Lisboa mañana ${filler}`);
    for (let j = 0; j < 8; j++) s.addTurn(c, 'user', `${filler} ${j}`);
    s.end(c, 'Lista de la compra');
    const a = s.begin('chat', 'Escapada a Lisboa');
    s.addTurn(a, 'user', 'quiero ir a Portugal el puente de diciembre');
    s.end(a, 'Escapada a Lisboa: vuelos y hotel');
    const b = s.begin('chat', 'Lisboa u Oporto');
    s.addTurn(b, 'user', 'comparar ciudades de Portugal');
    s.end(b, 'Decidimos entre Lisboa y Oporto');
    const titles = s.search('Lisboa').map((h) => h.title);
    expect(titles).toHaveLength(3);
    expect(titles.at(-1)).toBe('Compras');
  });

  it('la sesión que habla del tema en cabecera y turnos va primero', () => {
    const s = store();
    const a = s.begin('chat', 'Viaje a Lisboa');
    s.addTurn(a, 'user', 'quiero organizar el viaje a Lisboa en noviembre');
    s.end(a, 'Planificamos el viaje a Lisboa');
    const b = s.begin('chat', 'Compras');
    s.addTurn(b, 'user', `${filler} un amigo vuelve de Lisboa ${filler}`);
    s.end(b, 'Lista de la compra');
    const hits = s.search('Lisboa');
    expect(hits.map((h) => h.title)).toEqual(['Viaje a Lisboa', 'Compras']);
    // El fragmento sigue saliendo del turno que contiene la palabra.
    expect(hits[1]?.snippet).toContain('Lisboa');
  });

  it('el límite sigue contando sesiones distintas', () => {
    const s = store();
    for (let i = 0; i < 4; i++) {
      const x = s.begin('chat', `Lisboa ${i}`);
      for (let j = 0; j < 3; j++) s.addTurn(x, 'user', `Lisboa otra vez ${j}`);
      s.end(x, 'Lisboa');
    }
    expect(s.search('Lisboa', undefined, 2)).toHaveLength(2);
    expect(s.search('Lisboa', 'otro-chat')).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { resolveSpecialist } from '../src/core/specialists.js';

/**
 * Más nombres como los escribe el modelo (asis-expertos-4): «Google Calendar»,
 * «televisor» o «navegador» caían en el subagente genérico, sin las herramientas
 * del especialista. Ahora llegan al bueno; lo que no existe sigue en el genérico.
 */
describe('resolveSpecialist: Google Calendar, televisor y navegador', () => {
  it.each([
    ['Google Calendar', 'calendario'],
    ['google-calendar', 'calendario'],
    ['el calendario de Google', 'calendario'],
    ['GCal', 'calendario'],
    ['televisor', 'tv'],
    ['el televisor', 'tv'],
    ['Especialista del televisor', 'tv'],
    ['navegador', 'web'],
    ['el navegador', 'web'],
    ['browser', 'web'],
    // «del» se comía solo la «de» y quedaba «lcorreo»: caía en el genérico.
    ['especialista del correo', 'correo'],
    ['Especialista del PC', 'pc'],
    ['especialista en domótica', 'hogar'],
  ])('«%s» → %s', (name, canonical) => {
    expect(resolveSpecialist(name)?.name).toBe(canonical);
  });

  it.each(['google', 'calendario de', 'navegar', 'visor', 'teletienda'])(
    '«%s» no es un especialista (hijo genérico)',
    (name) => {
      expect(resolveSpecialist(name)).toBeUndefined();
    },
  );
});

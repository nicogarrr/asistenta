import { describe, expect, it } from 'vitest';
import { aboutTopicAnywhere } from '../src/memory/recuerdas.js';

/**
 * «¿Qué recuerdas del dentista?» con el perfil vacío iba al modelo (un turno entero) aunque
 * la memoria lo tuviera. Ahora se contesta al momento también desde la memoria.
 */
describe('«qué recuerdas de X» también mira la memoria', () => {
  const memory = [
    { id: 'a1b2c3', text: 'El dentista de Nico es el Dr. Pérez, en la calle Uría (Oviedo)' },
    { id: 'd4e5f6', text: 'Nico cambió de coche: ahora tiene un Seat León' },
  ];

  it('perfil sin nada del dentista → lo de la memoria, con su código para olvidarlo', () => {
    const text = aboutTopicAnywhere(['[dicho] Vivo en Gijón'], memory, 'dentista');
    expect(text).toContain('Sobre dentista recuerdo de lo que hemos hablado:');
    expect(text).toContain(
      '• El dentista de Nico es el Dr. Pérez, en la calle Uría (Oviedo) [a1b2c3]',
    );
    expect(text).not.toContain('Seat');
  });

  it('si el perfil lo tiene, manda el perfil', () => {
    const text = aboutTopicAnywhere(
      ['[dicho] Mi dentista es el Dr. García'],
      memory,
      'mi dentista',
    );
    expect(text).toContain('Sobre dentista tengo apuntado:');
    expect(text).not.toContain('Pérez');
  });

  it('en ningún sitio → null (lo lleva el modelo)', () => {
    expect(aboutTopicAnywhere([], memory, 'fontanero')).toBeNull();
  });
});

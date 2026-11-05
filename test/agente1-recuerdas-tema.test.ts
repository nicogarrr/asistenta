import { describe, expect, it } from 'vitest';
import {
  aboutMeText,
  aboutTopicRequest,
  aboutTopicText,
  entriesAbout,
  isAboutMeRequest,
} from '../src/memory/owner-facts.js';

/**
 * «¿Qué recuerdas del dentista?» o «qué sabes de mi hermana» no se reconocían: solo valía
 * «¿qué sabes de mí?» (todo el perfil). Iban al modelo, que a veces no miraba el perfil y
 * contestaba «no tengo nada». Ahora se contesta al momento con lo apuntado sobre ese tema.
 */
describe('«¿qué recuerdas de X?» contesta con lo apuntado sobre X', () => {
  const perfil = [
    '[dicho] Mi dentista es el Dr. García',
    '[dicho] Mis padres viven en Sevilla',
    '[auto] Mi hermana se llama Lucía',
    '[dicho] No me escribas antes de las 9h',
    '[dicho] Mi coche es un Seat León',
  ];

  it('reconoce las formas naturales', () => {
    expect(aboutTopicRequest('¿Qué recuerdas del dentista?')).toBe('dentista');
    expect(aboutTopicRequest('que tienes apuntado sobre mi coche')).toBe('mi coche');
    expect(aboutTopicRequest('¿Qué sabes de mi hermana?')).toBe('mi hermana');
    expect(aboutTopicRequest('qué te dije de mis padres')).toBe('mis padres');
    expect(aboutTopicRequest('Y qué te acuerdas de Lucía?')).toBe('lucia');
  });

  it('no se queda «de mí» ni preguntas de cultura', () => {
    expect(aboutTopicRequest('¿qué sabes de mí?')).toBeNull();
    expect(aboutTopicRequest('qué recuerdas de mí')).toBeNull();
    expect(isAboutMeRequest('¿qué sabes de mí?')).toBe(true);
    expect(aboutTopicRequest('¿qué sabes de Python?')).toBeNull();
    expect(aboutTopicRequest('qué sabes sobre la guerra de Troya')).toBeNull();
    expect(aboutTopicRequest('recuérdame el dentista mañana')).toBeNull();
  });

  it('encuentra las entradas del tema (plurales y tildes incluidos)', () => {
    expect(entriesAbout(perfil, 'dentista')).toEqual(['[dicho] Mi dentista es el Dr. García']);
    expect(entriesAbout(perfil, 'mi padre')).toEqual(['[dicho] Mis padres viven en Sevilla']);
    expect(entriesAbout(perfil, 'lucia')).toEqual(['[auto] Mi hermana se llama Lucía']);
    expect(entriesAbout(perfil, 'la moto')).toEqual([]);
  });

  it('la respuesta enseña lo apuntado sin prefijos y dice cómo borrarlo', () => {
    const text = aboutTopicText(perfil, 'mi coche');
    expect(text).toContain('Sobre coche tengo apuntado:');
    expect(text).toContain('• Mi coche es un Seat León');
    expect(text).not.toContain('[dicho]');
    expect(text).not.toContain('dentista');
    expect(text).toContain('«olvida lo de coche»');
  });

  it('sin nada apuntado devuelve null (lo lleva el modelo con el resto de la memoria)', () => {
    expect(aboutTopicText(perfil, 'la moto')).toBeNull();
    expect(aboutTopicText([], 'dentista')).toBeNull();
    expect(aboutMeText([])).toContain('Todavía no tengo nada');
  });
});

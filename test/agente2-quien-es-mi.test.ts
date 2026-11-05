import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { answerOwnerQuestion, ownerQuestionTopic } from '../src/memory/owner-questions.js';

/**
 * agente-2: «¿quién es mi dentista?» o «¿cómo se llama mi hermana?» siempre iban al modelo,
 * aunque lo tuviera apuntado (solo «¿qué recuerdas de…?» contestaba al momento). Ahora, si
 * lo apuntado casa del todo, contesta al momento y en segunda persona; si no, null.
 */
describe('preguntas directas sobre lo apuntado', () => {
  const ENTRIES = [
    '[dicho] Mi dentista es el Dr. García, en Getafe',
    '[dicho] Mi hermana se llama Lucía',
    '[dicho] Mi madre vive en Toledo',
    '[dicho] El cumple de mi madre es el 6 de noviembre',
    '[dicho] No me escribas antes de las 9',
    '[auto] Mi jefe es Pedro',
  ];

  it.each([
    ['¿quién es mi dentista?', 'Tu dentista es el Dr. García, en Getafe (lo tengo apuntado).'],
    ['¿cómo se llama mi hermana?', 'Tu hermana se llama Lucía (lo tengo apuntado).'],
    ['¿dónde vive mi madre?', 'Tu madre vive en Toledo (lo tengo apuntado).'],
    [
      '¿cuándo es el cumple de mi madre?',
      'El cumple de tu madre es el 6 de noviembre (lo tengo apuntado).',
    ],
    [
      '¿te acuerdas de mi dentista?',
      'Tu dentista es el Dr. García, en Getafe (lo tengo apuntado).',
    ],
    ['¿y quién es mi jefe?', 'Tu jefe es Pedro (lo tengo apuntado).'],
    [
      'cuándo es el cumpleaños de mi madre',
      'El cumple de tu madre es el 6 de noviembre (lo tengo apuntado).',
    ],
  ])('«%s» → al momento', (q, a) => {
    expect(answerOwnerQuestion(ENTRIES, q)).toBe(a);
  });

  it.each([
    '¿quién es Pedro Sánchez?',
    '¿quién es mi médico?',
    '¿cómo se llama mi padre?',
    '¿dónde vive mi hermano?',
    '¿te acuerdas de lo que te dije ayer?',
    '¿cuándo es el cumple de mi padre?',
    'mi dentista es el Dr. López',
  ])('«%s» → lo lleva el modelo', (q) => {
    expect(answerOwnerQuestion(ENTRIES, q)).toBeNull();
  });

  it('varias entradas que casan se listan', () => {
    const text = answerOwnerQuestion(
      ['Mi madre vive en Toledo', 'Mi madre vive en Madrid en invierno'],
      '¿dónde vive mi madre?',
    );
    expect(text).toBe(
      'Tengo apuntado:\n• Tu madre vive en Toledo\n• Tu madre vive en Madrid en invierno',
    );
  });

  it('el tema de cada pregunta', () => {
    expect(ownerQuestionTopic('¿Quién es mi dentista?')).toBe('mi dentista');
    expect(ownerQuestionTopic('¿qué tal?')).toBeNull();
  });

  it('el chat privado del dueño la contesta antes que el modelo (cli.ts)', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = cli.indexOf('const answerOwnerFacts = async');
    const end = cli.indexOf('const forget = forgetRequest(text);', start);
    expect(start).toBeGreaterThan(0);
    expect(cli.slice(start, end)).toContain(
      'answerOwnerQuestion(snapshot.load().split(ENTRY_SEPARATOR), text)',
    );
  });
});

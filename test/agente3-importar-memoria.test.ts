import { describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from '../src/channels/telegram-help.js';
import {
  IMPORT_PROMPT,
  ImportsPendientes,
  importAnswer,
  importPreview,
  isImportPaste,
  planImport,
} from '../src/memory/importar.js';

/**
 * Grok deja traer lo que otro asistente sabe de ti. Asistenta no tenía cómo: había que
 * contarle todo otra vez. Ahora /importar da el texto para ChatGPT/Grok, Nico pega la
 * respuesta y ve la lista antes de que se guarde nada.
 */
const PASTE = `**MEMORIA PARA ASISTENTA**
- Vivo en Gijón
- Mi hermana se llama Laura.
- Mi dentista es el Dr. López
- Soy del Sporting
- Soy del Sporting
- ¿Quieres que añada algo más?
- Mi contraseña del banco es 1234
- Trabajo en una consultora tecnológica
Aficiones:
• Juego al pádel los martes`;

describe('importar memoria de otro asistente', () => {
  it('el texto para pegar en ChatGPT/Grok pide la cabecera y un dato por línea', () => {
    expect(IMPORT_PROMPT.startsWith('MEMORIA PARA ASISTENTA')).toBe(true);
    expect(IMPORT_PROMPT).toContain('una línea por dato');
    expect(IMPORT_PROMPT).toContain('nada de contraseñas');
  });

  it('reconoce lo pegado aunque venga en negrita', () => {
    expect(isImportPaste(PASTE)).toBe(true);
    expect(isImportPaste('memoria para asistenta')).toBe(false);
    expect(isImportPaste('hola\n- algo')).toBe(false);
  });

  it('sin duplicar, sin preguntas ni claves, y sin pisar lo que Nico dijo él mismo', () => {
    const plan = planImport(PASTE, [
      '[dicho] Vivo en Gijón',
      '[dicho] Mi dentista es el Dr. García',
    ]);
    expect(plan.nuevos).toEqual([
      'Mi hermana se llama Laura',
      'Soy del Sporting',
      'Trabajo en una consultora tecnológica',
      'Juego al pádel los martes',
    ]);
    expect(plan.repetidos).toBe(1);
    expect(plan.choques).toEqual(['Mi dentista es el Dr. López']);
    expect(plan.descartados).toBe(3);
  });

  it('lo que no cabe en el perfil no se apunta (no echa lo que ya había)', () => {
    const plan = planImport(PASTE, [], 60);
    expect(plan.nuevos).toEqual(['Vivo en Gijón', 'Soy del Sporting']);
    expect(plan.sinSitio).toBeGreaterThan(0);
  });

  it('la lista sale numerada y dice cómo contestar', () => {
    const text = importPreview(planImport(PASTE, ['[dicho] Mi dentista es el Dr. García']));
    expect(text).toContain('1. Vivo en Gijón');
    expect(text).toContain('«sí», «no» o «sí menos 3, 5»');
    expect(text).toContain('me quedo con lo tuyo');
  });

  it.each([
    ['sí', [0, 1, 2, 3]],
    ['Sí, todos', [0, 1, 2, 3]],
    ['no', []],
    ['sí menos 2', [0, 2, 3]],
    ['todos menos el 1 y 4', [1, 2]],
    ['solo 2, 3', [1, 2]],
    ['sí menos 2-3', [0, 3]],
  ])('«%s» → %j', (answer, want) => {
    expect(importAnswer(answer, 4)).toEqual(want);
  });

  it('lo que no es una respuesta a la lista sigue su camino', () => {
    expect(importAnswer('¿qué tiempo hace mañana?', 4)).toBeNull();
    expect(importAnswer('menos 9', 4)).toBeNull();
  });

  it('la lista espera el «sí» 30 minutos', () => {
    const p = new ImportsPendientes();
    p.set('c', ['a'], 0);
    expect(p.peek('c', 29 * 60_000)).toEqual(['a']);
    expect(p.peek('c', 31 * 60_000)).toBeNull();
  });

  it('/memoria importar sale en /help', () => {
    const memoria = HELP_SECTIONS.flatMap((s) => s.entries).find((e) => e.command === 'memoria');
    expect(memoria?.args).toContain('importar');
  });
});

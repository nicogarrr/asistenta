import { describe, expect, it } from 'vitest';
import { classifyRequest, iterationBudgetFor } from '../src/core/router.js';

describe('classifyRequest', () => {
  it('honors an explicit user prefix over every signal', () => {
    for (const [text, level] of [
      ['n1: implementa un sistema entero', 1],
      ['N4: hola', 4],
      ['nivel 2: compara opciones', 2],
      ['nivel 3 - busca algo', 3],
    ] as const) {
      const c = classifyRequest(text);
      expect(c.level).toBe(level);
      expect(c.override).toBe(true);
    }
  });

  it('level 4 for multi-step build work', () => {
    expect(classifyRequest('implementa el router de niveles en el repo').level).toBe(4);
    expect(classifyRequest('despliega la nueva version a produccion').level).toBe(4);
    expect(classifyRequest('crea una app de seguimiento de gastos').level).toBe(4);
  });

  it('level 3 for single research/change tasks', () => {
    expect(classifyRequest('investiga por que falla el login').level).toBe(3);
    expect(classifyRequest('arregla el boton de la cabecera').level).toBe(3);
  });

  it('climbs to 4 when research comes with breadth', () => {
    const c = classifyRequest(
      'audita el modulo de memoria. Compara tres opciones de indice. Implementa la mejor.',
    );
    expect(c.level).toBe(4);
  });

  it('level 2 for single simple actions', () => {
    expect(classifyRequest('busca el telefono de la gestoria').level).toBe(2);
    expect(classifyRequest('pon un recordatorio manana a las 9').level).toBe(2);
  });

  it('level 1 for short direct questions and chatter', () => {
    expect(classifyRequest('hola').level).toBe(1);
    expect(classifyRequest('que hora es?').level).toBe(1);
    expect(classifyRequest('cual es la capital de Francia?').level).toBe(1);
  });

  it('defaults to 3 when nothing matches', () => {
    const c = classifyRequest(
      'esto es una frase sin verbos de accion concretos pero larga '.repeat(4),
    );
    expect(c.level).toBe(3);
    expect(c.override).toBe(false);
  });

  it('is deterministic', () => {
    const a = classifyRequest('investiga el error de ayer');
    const b = classifyRequest('investiga el error de ayer');
    expect(a).toEqual(b);
  });
});

describe('iterationBudgetFor', () => {
  it('shrinks small levels and never exceeds base', () => {
    expect(iterationBudgetFor(1, 60)).toBe(10);
    expect(iterationBudgetFor(2, 60)).toBe(25);
    expect(iterationBudgetFor(3, 60)).toBe(60);
    expect(iterationBudgetFor(4, 60)).toBe(60);
  });

  it('floors at base when base is already small', () => {
    expect(iterationBudgetFor(1, 5)).toBe(5);
    expect(iterationBudgetFor(2, 5)).toBe(5);
  });

  it('rejects a bad base', () => {
    expect(() => iterationBudgetFor(1, -1)).toThrow(RangeError);
    expect(() => iterationBudgetFor(1, 1.5)).toThrow(RangeError);
  });
});

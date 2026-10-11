import { readFileSync } from 'node:fs';
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

describe('presupuesto por nivel: contrato con Agent.run', () => {
  it('respeta un max personalizado (no asume 60)', () => {
    expect(iterationBudgetFor(1, 200)).toBe(10);
    expect(iterationBudgetFor(2, 200)).toBe(25);
    expect(iterationBudgetFor(3, 200)).toBe(60);
    expect(iterationBudgetFor(4, 200)).toBe(200);
  });

  it('n4 nunca recorta aunque el max sea pequeno', () => {
    expect(iterationBudgetFor(4, 10)).toBe(10);
    expect(iterationBudgetFor(4, 1)).toBe(1);
  });

  it('override por prefijo solo elige nivel; el tope sigue saliendo del max real', () => {
    const forced = classifyRequest('n1: implementa una app completa');
    expect(forced.level).toBe(1);
    expect(iterationBudgetFor(forced.level, 500)).toBe(10);
  });

  it('Agent.run nunca consume el presupuesto compartido ni lo reinicia (guardia de regresion)', () => {
    const src = readFileSync(new URL('../src/core/agent.ts', import.meta.url), 'utf8');
    // Un hijo/subagente comparte su IterationBudget con el padre: si run()
    // volviera a consumir para recortar, quemaria el contador del padre,
    // el hijo heredaria un resto ya gastado y un retry quedaria sin margen.
    expect(src).not.toMatch(/this\.#budget\.consume\(/);
    expect(src).not.toMatch(/this\.#budget\.reset\(/);
    // El tope por nivel se aplica solo al techo de ESTA corrida.
    expect(src).toMatch(/#runToolCallCeiling = iterationBudgetFor\(/);
  });
});

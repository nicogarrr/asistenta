import { describe, expect, it } from 'vitest';
import { renderMemoryContext } from '../src/memory/context.js';
import type { MemoryEntry } from '../src/memory.js';

const entry = (id: string, text: string, tags: string[] = []): MemoryEntry => ({
  id,
  date: '2026-10-30',
  text,
  tags,
  supersedes: [],
  supersededBy: null,
});

const RULE =
  'Cuando te pida un resumen, respóndeme en tres frases como máximo y sin listas ni negritas, por favor';

describe('reglas aprendidas en la memoria del turno', () => {
  it('una regla aprendida sigue entera aunque haya muchos recuerdos más nuevos', () => {
    const newer = Array.from({ length: 8 }, (_, i) => entry(`n${i}`, `Dato normal número ${i}`));
    const out = renderMemoryContext([entry('r1', RULE, ['aprendido']), ...newer]);
    expect(out?.body).toContain(RULE);
  });

  it('si no cabe todo, caen antes los recuerdos normales viejos que la regla', () => {
    const long = (i: number) => `Recuerdo largo ${i} ${'x'.repeat(150)}`;
    const many = Array.from({ length: 60 }, (_, i) => entry(`m${i}`, long(i)));
    const out = renderMemoryContext([entry('r1', RULE, ['aprendido']), ...many]);
    expect(out?.hiddenByCap).toBeGreaterThan(0);
    expect(out?.body).toContain(RULE);
  });
});

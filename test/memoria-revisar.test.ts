import { describe, expect, it } from 'vitest';
import { contradictionsReply, findContradictions } from '../src/memory/review.js';

describe('/memoria revisar', () => {
  it('encuentra la pareja que se contradice y deja fuera lo demás', () => {
    const entries = [
      { id: 'm1', text: 'Vive en Madrid' },
      { id: 'm2', text: 'Le gusta el café solo' },
      { id: 'm3', text: 'No vive en Madrid' },
    ];
    const pairs = findContradictions(entries);
    expect(pairs.map(([a, b]) => [a.id, b.id])).toEqual([['m1', 'm3']]);
    const r = contradictionsReply(entries);
    expect(r).toContain('Posibles contradicciones (1):');
    expect(r).toContain('1. [m1] Vive en Madrid');
    expect(r).toContain('   [m3] No vive en Madrid');
    expect(r).toContain('/memoria olvidar <id>');
    expect(r).not.toContain('café');
  });

  it('sin contradicciones: lo dice claro', () => {
    expect(contradictionsReply([{ id: 'a', text: 'Tiene un perro' }])).toBe(
      'No veo contradicciones en la memoria de este chat.',
    );
    expect(contradictionsReply([])).toBe('No veo contradicciones en la memoria de este chat.');
  });

  it('muchas parejas: enseña 10 y resume el resto', () => {
    const entries = Array.from({ length: 12 }, (_, i) => [
      { id: `s${i}`, text: `Trabaja en la empresa numero${i}` },
      { id: `n${i}`, text: `No trabaja en la empresa numero${i}` },
    ]).flat();
    const r = contradictionsReply(entries);
    expect(r).toContain('10. [');
    expect(r).not.toContain('11. [');
    expect(r).toMatch(/… y \d+ más/);
  });
});

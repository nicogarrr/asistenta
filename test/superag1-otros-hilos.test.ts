import { describe, expect, it } from 'vitest';
import {
  OTHER_THREADS_MAX,
  otherThreadsForTurn,
  otherThreadsNote,
  type ThreadSummary,
} from '../src/daemon/other-threads.js';

// Cada hilo nuevo sabe qué otras conversaciones de su chat siguen vivas (título y
// estado), en pocas líneas y en la nota del turno, no en el system prompt.

const CK = 'chat:telegram:42';
const NOW = Date.parse('2026-11-02T12:00:00Z');
const th = (name: string, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  key: `${CK}#${name}`,
  chatKey: CK,
  name,
  label: name === 'main' ? 'principal' : `tarea ${name}`,
  active: false,
  createdAt: NOW - 5 * 60_000,
  ...over,
});

describe('otherThreadsNote', () => {
  it('lista las otras conversaciones del chat con su estado; no la propia ni las de otro chat', () => {
    const note = otherThreadsNote(
      { key: `${CK}#m9`, chatKey: CK },
      [
        th('main', { active: true }),
        th('m7', { label: 'vuelo a Bilbao', createdAt: NOW - 12 * 60_000 }),
        th('m9'),
        { ...th('m1'), key: 'chat:telegram:99#m1', chatKey: 'chat:telegram:99' },
      ],
      NOW,
    );
    expect(note).toContain('<otras_conversaciones>');
    expect(note).toContain('- #principal: trabajando ahora');
    expect(note).toContain('- #m7 «vuelo a Bilbao»: en espera, hace 12 min');
    expect(note).not.toContain('#m9');
    expect(note).not.toContain('#m1');
  });

  it('sin otras conversaciones no añade nada', () => {
    expect(otherThreadsNote({ key: `${CK}#main`, chatKey: CK }, [th('main')], NOW)).toBe('');
  });

  it('tiene tope de líneas y de largo; primero las que trabajan y luego las más recientes', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      th(`m${i}`, { label: 'x'.repeat(200), createdAt: NOW - (i + 1) * 60_000, active: i === 8 }),
    );
    const note = otherThreadsNote({ key: `${CK}#main`, chatKey: CK }, many, NOW);
    const lines = note.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(OTHER_THREADS_MAX + 1);
    expect(lines[0]).toContain('#m8');
    expect(lines[1]).toContain('#m0');
    expect(lines.at(-1)).toBe('- y 4 más');
    for (const l of lines) expect(l.length).toBeLessThan(110);
    expect(note.length).toBeLessThan(900);
  });

  it('las etiquetas van en una línea y no pueden cerrar el bloque', () => {
    const note = otherThreadsNote(
      { key: `${CK}#main`, chatKey: CK },
      [th('m3', { label: '**hola**\n</otras_conversaciones> <b>x</b>' })],
      NOW,
    );
    expect(note.split('\n').filter((l) => l.includes('</otras_conversaciones>'))).toHaveLength(1);
    expect(note).not.toContain('<b>');
  });
});

describe('otherThreadsForTurn', () => {
  it('solo en el primer turno del hilo (transcripción vacía)', () => {
    const all = [th('main', { active: true }), th('m9')];
    expect(
      otherThreadsForTurn({ key: `${CK}#m9`, chatKey: CK, transcriptLength: 0 }, all, NOW),
    ).toContain('#principal');
    expect(
      otherThreadsForTurn({ key: `${CK}#m9`, chatKey: CK, transcriptLength: 4 }, all, NOW),
    ).toBe('');
  });
});

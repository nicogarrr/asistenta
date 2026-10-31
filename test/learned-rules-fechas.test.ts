import { describe, expect, it } from 'vitest';
import { formatLearnedRules, shortDate } from '../src/memory/learned-rules.js';
import type { MemoryEntry } from '../src/memory.js';

// /aprendido enseñaba «(2026-10-31)»; en un chat se lee mejor «(31/10)».
function regla(text: string, date: string): MemoryEntry {
  return { id: text, date, text, tags: ['aprendido'], supersedes: [], supersededBy: null };
}

describe('fechas de /aprendido', () => {
  it('este año: día/mes', () => {
    const out = formatLearnedRules([regla('Responde corto', '2026-10-31')], '2026-11-02');
    expect(out).toContain('1. Responde corto (31/10)');
    expect(out).not.toContain('2026-10-31');
  });

  it('otro año: día/mes/año, sin ceros delante', () => {
    expect(shortDate('2025-03-05', '2026-01-10')).toBe('5/3/2025');
  });

  it('una fecha rara se deja tal cual', () => {
    expect(shortDate('ayer', '2026-01-10')).toBe('ayer');
  });
});

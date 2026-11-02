import { describe, expect, it } from 'vitest';
import { buildWeeklySummary } from '../src/weekly.js';

const now = Date.parse('2026-11-01T18:00:00Z');
const at = (h: number) => new Date(now - h * 3_600_000).toISOString();

describe('resumen semanal: singular cuando es 1', () => {
  it('«1 falló», «1 enviada», «1 terminada»', () => {
    const text = buildWeeklySummary({
      now,
      pending: '',
      watching: 0,
      entries: [
        { ts: at(1), action: 'turn', result: 'ok' },
        { ts: at(2), action: 'turn', result: 'error' },
        { ts: at(3), action: 'descarga', result: 'ok' },
        { ts: at(4), action: 'descarga', result: 'error' },
      ] as never,
      playbooks: [{ domain: 'seg-social.es', ok: 1, failed: 0 }],
    });
    expect(text).toContain('Peticiones atendidas: 2 (1 falló).');
    expect(text).toContain('Descargas: 1 enviada, 1 falló.');
    expect(text).toContain('seg-social.es: 1 terminada, 0 sin terminar.');
    expect(text).not.toMatch(/\b1 (fallaron|enviadas|terminadas)\b/);
  });
});

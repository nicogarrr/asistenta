import { describe, expect, it } from 'vitest';
import { parseSince } from '../src/audit/audit-cli.js';

describe('pa auditoria --since <día>', () => {
  it('un día sin hora empieza a la medianoche local, no a la de UTC', () => {
    // vitest corre con TZ=Europe/Madrid: el 1 de noviembre empieza a las 23:00 UTC del 31.
    expect(parseSince('2026-11-01')).toBe(new Date(2026, 10, 1).toISOString());
    expect(new Date(parseSince('2026-11-01')).getHours()).toBe(0);
    expect(parseSince(' 2026-07-15 ')).toBe(new Date(2026, 6, 15).toISOString());
  });

  it('lo demás no cambia', () => {
    expect(parseSince('2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00Z');
    expect(parseSince('2026-13-45')).toBe('2026-13-45');
  });
});

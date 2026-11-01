import { describe, expect, it } from 'vitest';
import * as cli from '../src/cli.js';
import * as hits from '../src/daemon/session-hits.js';

// P2 (ARCHITECTURE.md): formatSessionHits lives in src/daemon/session-hits.ts;
// cli.ts re-exports the very same function, so every existing import keeps working.
describe('session-hits module', () => {
  it('cli.ts re-exports the same function (pure move)', () => {
    expect(typeof hits.formatSessionHits).toBe('function');
    expect(cli.formatSessionHits).toBe(hits.formatSessionHits);
  });

  it('behaves as before', () => {
    expect(hits.formatSessionHits([], 'renfe')).toContain('No he encontrado nada sobre "renfe"');
    const out = hits.formatSessionHits([
      { title: '  ', at: Date.UTC(2026, 9, 30, 12), snippet: 'billete\n de  tren' } as never,
    ]);
    expect(out.split('\n')[0]).toBe('Esto es lo que encontré (1):');
    expect(out).toContain('- sin título (');
    expect(out).toContain('): billete de tren');
  });
});

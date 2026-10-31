import { describe, expect, it, vi } from 'vitest';
import { SUPERVISOR_MESSAGES } from '../src/autostart.js';
import { autoupdateCommand } from '../src/autoupdate-cli.js';

// Estos avisos le llegan a Nico por Telegram: tienen que entenderse sin saber qué es un latido,
// un supervisor, un launcher o un daemon.
const JERGA = /latido|supervisor|launcher|daemon|logs|declar|presupuesto|instancia/i;

describe('avisos del vigilante en castellano llano', () => {
  it.each(Object.entries(SUPERVISOR_MESSAGES))('%s: sin jerga', (_k, text) => {
    expect(text).not.toMatch(JERGA);
    expect(text.length).toBeLessThan(220);
  });

  it('los que piden actuar dicen dónde mirar', () => {
    for (const k of ['forced', 'blocked', 'supervisor', 'heartbeat'] as const) {
      expect(SUPERVISOR_MESSAGES[k]).toMatch(/En el PC, pa autostart status/);
    }
  });

  it('pa autoupdate now fuera de Windows lo dice sin jerga', async () => {
    if (process.platform === 'win32') return;
    let err = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      err += String(s);
      return true;
    });
    try {
      expect(await autoupdateCommand(['now'], { stateDir: '/nonexistent-pa', repo: '.' })).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(err).toBe('La autoactualización solo funciona en Windows.\n');
  });
});

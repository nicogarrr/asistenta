import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedReply } from '../src/cli.js';
import { statusCommand } from '../src/daemon-status.js';

// Nico (31 oct): que Asistenta hable como en un chat. `pa status` y los fallos
// internos sin «PID» ni «(error interno)».
describe('textos fijos sin jerga (5)', () => {
  it('fallo interno: sin «(error interno)» ni «mira /estado»', () => {
    const t = failedReply('No he podido usar la cámara', { a: 1 });
    expect(t).toBe(
      'No he podido usar la cámara. Algo ha fallado por mi parte; vuelve a intentarlo en un momento.',
    );
    expect(t).not.toContain('error interno');
    expect(t).not.toContain('/estado');
  });

  it('pa status con Asistenta parada: sin «PID»', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voz5-'));
    let out = '';
    try {
      statusCommand([], { stateDir: dir }, (s) => {
        out += s;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(out.split('\n')[0]).toBe('No encuentro Asistenta en marcha.');
    expect(out).not.toMatch(/\bPID\b/);
  });
});

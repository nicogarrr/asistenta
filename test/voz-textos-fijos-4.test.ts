import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';
import { readFailureCause } from '../src/watch/pages.js';

// Nico (31 oct): que Asistenta hable como en un chat. `pa diagnose` y los avisos
// de webs vigiladas sin «pid», «heartbeat», «wake word» ni «queda en el registro».
let dir: string;
const NOW = Date.parse('2026-10-03T12:00:00Z');
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voz4-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('textos fijos sin jerga (4)', () => {
  it('pa diagnose en marcha: «en marcha: sí» y «última señal de vida»', async () => {
    writeFileSync(join(dir, 'agent.pid'), '4242');
    writeFileSync(join(dir, 'agent.heartbeat'), String(NOW - 5_000));
    const { text } = await diagnose({
      stateDir: dir,
      now: () => NOW,
      isAlive: () => true,
      wake: () => ({ running: true }),
    });
    expect(text).toContain('en marcha: sí (proceso 4242)');
    expect(text).toContain('última señal de vida: ');
    expect(text).toContain('palabra de activación: escuchando');
    expect(text).not.toMatch(/\b(pid|heartbeat|wake word):/);
    expect(text).not.toContain('fichero de pid');
  });

  it('pa diagnose parada: sin «MUERTO» ni «warn»', async () => {
    writeFileSync(join(dir, 'agent.pid'), '4242');
    const { text } = await diagnose({ stateDir: dir, now: () => NOW, isAlive: () => false });
    expect(text).toContain('en marcha: no, se ha parado (proceso 4242)');
    expect(text).toContain('última señal de vida: ninguna');
    expect(text).toContain('ningún aviso ni error en ese tiempo');
    expect(text).not.toContain('MUERTO');
    expect(text).not.toContain('warn');
    expect(text).not.toContain('en la ventana');
  });

  it('web vigilada que falla sin motivo claro: sin «queda en el registro»', () => {
    const cause = readFailureCause('Error: zzq ENOTSUP xyz');
    expect(cause).toBe('no sé bien por qué');
    expect(cause).not.toContain('registro');
  });
});

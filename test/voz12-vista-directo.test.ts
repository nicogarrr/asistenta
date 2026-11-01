import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LIVE_BUSY_TEXT,
  LIVE_STOPPED_TEXT,
  liveCaption,
  liveStopAnswer,
} from '../src/vista-directo.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('la vista en directo se para con un «para» normal', () => {
  it('los avisos no mandan a /screen off ni /camera off', () => {
    for (const t of [
      liveCaption('screen'),
      liveCaption('camera'),
      LIVE_BUSY_TEXT,
      LIVE_STOPPED_TEXT,
    ]) {
      expect(t).not.toMatch(/\/\w/);
    }
    expect(liveCaption('camera')).toBe(
      'Cámara en directo, se actualiza sola. Cuando quieras que la pare, dime «para».',
    );
    expect(cli).not.toContain('/camera off para parar');
    expect(cli).not.toContain('/screen off para parar');
    expect(cli).not.toContain('Para pararla, /screen off o /camera off');
  });

  it('entiende «para», «párala», «apágala ya» y no frases normales', () => {
    for (const t of [
      'para',
      'Para.',
      'párala',
      'páralo!',
      'apágala',
      'basta',
      'para la vista',
      'quítala ya',
    ]) {
      expect(liveStopAnswer(t), t).toBe(true);
    }
    for (const t of ['para mañana', 'para qué sirve esto', '¿qué ves?', 'no', 'parada']) {
      expect(liveStopAnswer(t), t).toBe(false);
    }
  });

  it('el «para» solo actúa con una vista abierta en ese chat, antes del modelo', () => {
    expect(cli).toContain(
      'if (!liveViews.has(inbound.chatId) || !liveStopAnswer(inbound.text)) return false;',
    );
    expect(cli).toContain('if (await stopLiveByWords(inbound)) return;');
    expect(cli.indexOf('if (await stopLiveByWords(inbound)) return;')).toBeLessThan(
      cli.indexOf('if (LEARN_END_RESPUESTA.test(inbound.text.trim()))'),
    );
  });
});

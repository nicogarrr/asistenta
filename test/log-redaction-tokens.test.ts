import { describe, expect, it } from 'vitest';
import { redact, scrubLogText } from '../src/log.js';

const TG = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const GKEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';

describe('secretos de Telegram y Gemini en texto libre', () => {
  it('tapa un token de bot de Telegram fuera de una URL', () => {
    const out = scrubLogText(`bot arrancado con ${TG} en marcha`);
    expect(out).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    expect(out).toContain('[redacted]');
  });

  it('tapa una clave de Gemini (AIza…) en el mensaje de un error', () => {
    const fields = redact({ err: new Error(`API key not valid: ${GKEY}`) });
    expect(JSON.stringify(fields)).not.toContain(GKEY);
  });

  it('no toca horas ni ids numéricos normales', () => {
    expect(scrubLogText('turno 12:30 chat 123456789:ok')).toBe('turno 12:30 chat 123456789:ok');
  });
});

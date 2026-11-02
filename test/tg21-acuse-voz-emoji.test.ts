/**
 * El acuse de una nota de voz («🎙️ «…»») se cortaba a 299 unidades con slice a ciegas: si
 * ahí caía un emoji, quedaba medio par sustituto, que Telegram rechaza o enseña como «�».
 */
import { describe, expect, it } from 'vitest';
import { voiceHeardText } from '../src/channels/telegram-receipts.js';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('acuse de nota de voz larga', () => {
  it('no parte un emoji por la mitad al cortar', () => {
    const out = voiceHeardText(`${'a'.repeat(298)}😀 y sigue hablando un buen rato`);
    expect(loneSurrogate.test(out)).toBe(false);
    expect(out).toBe(`🎙️ «${'a'.repeat(298)}…»`);
  });

  it('el corte normal sigue igual', () => {
    const out = voiceHeardText('b'.repeat(400));
    expect(out).toBe(`🎙️ «${'b'.repeat(299)}…»`);
    expect(voiceHeardText('hola  qué tal')).toBe('🎙️ «hola qué tal»');
  });
});

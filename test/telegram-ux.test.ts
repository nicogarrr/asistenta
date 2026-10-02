import { describe, expect, it } from 'vitest';
import {
  cleanForTelegram,
  formatAsList,
  progressMessage,
  resultLine,
  shorten,
  stripVoicePrefix,
} from '../src/channels/formatters.js';
import { parseMessageRef } from '../src/channels/telegram.js';

describe('cleanForTelegram', () => {
  it('flattens markdown into plain text', () => {
    const messy = [
      '## Resumen',
      '',
      '**Importante:** ya está hecho.',
      '',
      '| Nombre | Estado |',
      '| --- | --- |',
      '| Compra | hecha |',
      '',
      '```',
      'const x = 1;',
      '```',
      '',
      '• primer punto',
      '• segundo punto',
    ].join('\n');
    const expected = [
      'Resumen',
      '',
      'Importante: ya está hecho.',
      '',
      'Nombre - Estado',
      'Compra - hecha',
      '',
      'const x = 1;',
      '',
      '- primer punto',
      '- segundo punto',
    ].join('\n');
    expect(cleanForTelegram(messy)).toBe(expected);
  });

  it('keeps the words of a header and drops the hashes', () => {
    expect(cleanForTelegram('### Titulo de prueba')).toBe('Titulo de prueba');
    expect(cleanForTelegram('Titulo de prueba')).toBe('Titulo de prueba');
  });

  it('never rewrites code inside a fence', () => {
    expect(cleanForTelegram('```\n**no tocar** | a\n```')).toBe('**no tocar** | a');
  });

  it('leaves prose alone', () => {
    expect(cleanForTelegram('La compra está hecha.')).toBe('La compra está hecha.');
  });
});

describe('shorten', () => {
  it('leaves short text alone', () => {
    expect(shorten('Ya está hecha la compra.')).toEqual({
      text: 'Ya está hecha la compra.',
      truncated: false,
    });
  });

  it('treats exactly maxChars as fitting', () => {
    expect(shorten('a'.repeat(300)).truncated).toBe(false);
    expect(shorten('a'.repeat(301)).truncated).toBe(true);
  });

  it('cuts at a word boundary and offers the detail', () => {
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const result = shorten(words, 60);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('alpha beta gamma delta epsilon…\nDime "más" para el detalle.');
  });

  it('keeps the whole reply within the limit', () => {
    const long = 'La compra está hecha. '.repeat(30);
    const result = shorten(long);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.text.endsWith('…\nDime "más" para el detalle.')).toBe(true);
    // The kept part is a whole-word prefix of the original, never a half word.
    const body = result.text.slice(0, result.text.indexOf('…'));
    expect(long.startsWith(body)).toBe(true);
    expect(body).not.toMatch(/\s$/);
  });
});

describe('progressMessage', () => {
  it('varies across repeated calls', () => {
    const seen = new Set(Array.from({ length: 20 }, () => progressMessage()));
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('returns a short Spanish phrase', () => {
    for (const phrase of Array.from({ length: 20 }, () => progressMessage())) {
      expect(phrase.length).toBeGreaterThan(0);
      expect(phrase.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('resultLine', () => {
  it('keeps the outcome sentence and drops the narration', () => {
    expect(resultLine('Primero abro YouTube. Luego busco la canción. Ya está sonando.')).toBe(
      'Ya está sonando.',
    );
  });

  it('condenses step clauses into one sentence', () => {
    const result = resultLine(
      'Primero abro el navegador, luego escribo la URL y después pulso Intro.',
    );
    expect(result).toBe('Pulso Intro.');
    expect(result).not.toMatch(/primero|luego|después/i);
    expect(result.split(/(?<=[.!?])\s+/)).toHaveLength(1);
  });

  it('drops "voy a / ahora" narration the same way', () => {
    const result = resultLine('Voy a abrir YouTube, ahora busco la canción y le doy al play.');
    expect(result).toBe('Busco la canción y le doy al play.');
  });

  it('leaves a plain result sentence untouched', () => {
    expect(resultLine('Ya está sonando.')).toBe('Ya está sonando.');
    expect(resultLine('')).toBe('');
  });
});

describe('formatAsList', () => {
  it('formats items as plain dashes', () => {
    expect(formatAsList(['Pan', ' leche ', ''])).toBe('- Pan\n- leche');
    expect(formatAsList(['uno', 'dos'])).toBe('- uno\n- dos');
  });

  it('returns an empty string for no items', () => {
    expect(formatAsList([])).toBe('');
  });
});

describe('stripVoicePrefix', () => {
  it('removes the transcription marker', () => {
    expect(stripVoicePrefix('[Nota de voz transcrita] pon la música')).toBe('pon la música');
    expect(stripVoicePrefix('Nota de voz transcrita: hola')).toBe('hola');
  });

  it('leaves ordinary text alone', () => {
    expect(stripVoicePrefix('pon la música')).toBe('pon la música');
    expect(stripVoicePrefix('')).toBe('');
  });
});

describe('parseMessageRef', () => {
  it('parses the string ids the channel layer carries', () => {
    expect(parseMessageRef('123', '456')).toEqual({ chatId: 123, messageId: 456 });
    // Group chats use negative ids, so those must survive.
    expect(parseMessageRef('-100123', '7')).toEqual({ chatId: -100123, messageId: 7 });
    expect(parseMessageRef(' 123 ', ' 456 ')).toEqual({ chatId: 123, messageId: 456 });
  });

  it('rejects ids that cannot name a message', () => {
    expect(parseMessageRef('', '1')).toBeNull();
    expect(parseMessageRef('1', '')).toBeNull();
    expect(parseMessageRef('abc', '1')).toBeNull();
    expect(parseMessageRef('1', '1.5')).toBeNull();
    expect(parseMessageRef('0', '1')).toBeNull();
    expect(parseMessageRef('1', '0')).toBeNull();
  });
});

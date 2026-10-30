import { describe, expect, it } from 'vitest';
import {
  cleanForTelegram,
  formatAsList,
  hasRichContent,
  progressMessage,
  progressNote,
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
      '```',
      'const x = 1;',
      '```',
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
    expect(cleanForTelegram('```\n**no tocar** | a\n```')).toBe('```\n**no tocar** | a\n```');
  });

  it('keeps the fence markers and the language tag', () => {
    // Telegram renders a fenced block as a copy-friendly code bubble; unwrapping it
    // left the listing as an anonymous wall of lines that looked like a mistake.
    expect(cleanForTelegram('```ts\nconst x: number = 1;\n```')).toBe(
      '```ts\nconst x: number = 1;\n```',
    );
    expect(cleanForTelegram('~~~python\nprint(1)\n~~~')).toBe('~~~python\nprint(1)\n~~~');
  });

  it('keeps blank lines inside a fence, since PEP 8 asks for two', () => {
    const python = [
      '```python',
      'def a():',
      '    pass',
      '',
      '',
      'def b():',
      '    pass',
      '```',
    ].join('\n');
    expect(cleanForTelegram(python)).toBe(python);
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
    // Holgura en prosa: hasta presupuesto × 1,5 llega entero (no compensa recortar).
    expect(shorten('a'.repeat(450)).truncated).toBe(false);
    expect(shorten('a'.repeat(451)).truncated).toBe(true);
  });

  it('cuts at a word boundary and offers the detail', () => {
    const words =
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma';
    const result = shorten(words, 60);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('alpha beta gamma delta…\nPulsa «📖 Ver todo» o dime «más».');
  });

  it('keeps the whole reply within the limit', () => {
    const long = 'La compra está hecha. '.repeat(30);
    const result = shorten(long);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.text.endsWith('…\nPulsa «📖 Ver todo» o dime «más».')).toBe(true);
    // The kept part is a whole-word prefix of the original, never a half word.
    const body = result.text.slice(0, result.text.indexOf('…'));
    expect(long.startsWith(body)).toBe(true);
    expect(body).not.toMatch(/\s$/);
  });

  it('cuts long plain prose at a word boundary and adds the hint', () => {
    const long = 'Esta es una frase normal y corriente, sin nada especial. '.repeat(40);
    expect(long.length).toBeGreaterThan(2000);
    const result = shorten(long);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.text.endsWith('…\nPulsa «📖 Ver todo» o dime «más».')).toBe(true);
    const body = result.text.slice(0, result.text.indexOf('…'));
    expect(long.startsWith(body)).toBe(true);
    expect(body).not.toMatch(/\s$/);
  });

  it('honours an explicit maxChars for plain text', () => {
    const result = shorten('palabra '.repeat(250), { maxChars: 300 });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.text.length).toBeGreaterThan(250);
  });

  it('honours the chosen ceiling for the body plus the hint', () => {
    const prose = 'Esta es una frase normal sin nada raro. '.repeat(60);
    const tight = shorten(prose, { maxChars: 500, hardMaxChars: 1000 });
    expect(tight.truncated).toBe(true);
    expect(tight.text.length).toBeLessThanOrEqual(500);
    expect(tight.text.endsWith('…\nPulsa «📖 Ver todo» o dime «más».')).toBe(true);

    // The very same reply only survives intact because of the generous ceiling, so
    // the ceiling and not the prose budget is what is deciding here.
    const code = [
      'Explicación corta.',
      '',
      '```ts',
      ...Array.from({ length: 80 }, (_, i) => `const valor${i} = "linea ${i}";`),
      '```',
    ].join('\n');
    expect(shorten(code, { maxChars: 500, hardMaxChars: 1000 }).truncated).toBe(true);
    expect(shorten(code, { maxChars: 500, hardMaxChars: 2500 }).truncated).toBe(false);
  });
});

describe('shorten with code', () => {
  it('does not cut a twenty line block', () => {
    const lines = Array.from({ length: 18 }, (_, i) => `const valor${i} = "linea ${i}";`);
    const code = ['```ts', ...lines, '```'].join('\n');
    expect(code.length).toBeGreaterThan(300);
    const result = shorten(code);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(code);
    for (const line of lines) expect(result.text).toContain(line);
  });

  it('leaves a 3000 character block completely intact', () => {
    // The regression: the old fixed 300 char cut kept the fence and three lines and
    // threw the other 97 away, which is worse than sending the whole listing.
    const body = Array.from(
      { length: 95 },
      (_, i) => `# linea ${String(i).padStart(3, '0')} del bloque de codigo`,
    ).join('\n');
    const code = `\`\`\`python\n${body}\n\`\`\``;
    expect(code.length).toBeGreaterThan(3000);
    expect(code.length).toBeLessThanOrEqual(3500);
    const result = shorten(code);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(code);
  });

  it('cuts outside the block instead of halving it', () => {
    const huge = Array.from(
      { length: 200 },
      (_, i) => `linea ${i} de un bloque de codigo bastante largo`,
    ).join('\n');
    const text = `Aquí va el bloque:\n\n\`\`\`ts\n${huge}\n\`\`\``;
    expect(text.length).toBeGreaterThan(3500);
    const result = shorten(text);
    expect(result.truncated).toBe(true);
    // At a paragraph break, before the fence: no dangling opening marker, and no
    // half a code block pretending to be one.
    expect(result.text).toBe('Aquí va el bloque:…\nPulsa «📖 Ver todo» o dime «más».');
    expect(result.text).not.toContain('```');
  });

  it('never cuts an indented block either', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `    const valor${i} = ${i};`);
    const indented = ['Explicación de la función:', ...lines].join('\n');
    expect(indented.length).toBeGreaterThan(300);
    const result = shorten(indented);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(indented);
  });
});

describe('shorten with links', () => {
  const longUrl = `https://example.com/reports/${'segment-'.repeat(20)}final?token=${'x'.repeat(40)}`;

  it('keeps a long URL whole instead of cutting it at 300', () => {
    const text = `Aquí tienes el informe completo:\n\n${longUrl}\n\nCuando lo abras ya lo vemos.`;
    expect(text.length).toBeGreaterThan(300);
    const result = shorten(text);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain(longUrl);
  });

  it('keeps the URL whole when the rest of the reply is cut', () => {
    const text = `${longUrl}\n\n${'Explicación larga del asunto. '.repeat(120)}`;
    expect(text.length).toBeGreaterThan(3500);
    const result = shorten(text);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(longUrl);
    expect(result.text.length).toBeLessThanOrEqual(3500);
  });

  it('cuts around a URL that lands on the boundary, never inside it', () => {
    const url = `https://example.com/${'a'.repeat(180)}`;
    // Positioned so the limit falls in the middle of the URL.
    const text = `${'palabra '.repeat(486)}${url} ${'palabra '.repeat(200)}`;
    expect(text.length).toBeGreaterThan(3500);
    const result = shorten(text);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(3500);
    // Either the whole URL or none of it, never a dead fragment.
    expect(result.text).not.toMatch(/https?:\/\//);
    expect(result.text).not.toContain(url.slice(0, 40));
  });

  it('does not split an email address either', () => {
    const address = `${'nombre.apellido'.repeat(6)}@empresa.example.com`;
    const text = `Escríbele a ${address} para el aviso.`;
    expect(text.length).toBeLessThan(300);
    expect(shorten(text).text).toBe(text);
  });
});

describe('hasRichContent', () => {
  it('is false for ordinary prose', () => {
    expect(hasRichContent('La compra está hecha y el pago se confirmó ayer.')).toBe(false);
    expect(hasRichContent('Eeeeeeeeeeeeeeeeeeeeeeee')).toBe(false);
    expect(hasRichContent('')).toBe(false);
    // A long run of one letter is not an identifier, so it keeps the prose budget.
    expect(hasRichContent('a'.repeat(300))).toBe(false);
  });

  it('is true for a fenced block', () => {
    expect(hasRichContent('```js\nconst a = 1;\n```')).toBe(true);
    expect(hasRichContent('Mira esto:\n\n~~~python\nprint(1)\n~~~')).toBe(true);
    // An unclosed fence still means the model is writing code.
    expect(hasRichContent('```\nconst a = 1;')).toBe(true);
  });

  it('is true for an indented block', () => {
    expect(hasRichContent('    const a = 1;')).toBe(true);
    expect(hasRichContent('\tconst a = 1;')).toBe(true);
  });

  it('is true for a URL', () => {
    expect(hasRichContent('Mira https://example.com/x')).toBe(true);
    expect(hasRichContent('Ver http://a.co')).toBe(true);
  });

  it('is true for a long path', () => {
    expect(hasRichContent('/Users/nicoi/projects/personal-agent/src/channels/formatters.ts')).toBe(
      true,
    );
    expect(hasRichContent('C:\\Users\\nicoi\\projects\\personal-agent\\src\\index.ts')).toBe(true);
  });

  it('is true for a long hex or base64 identifier', () => {
    expect(hasRichContent('3f8a9c2b1d4e5f60718293a4b5c6d7e8f9012345')).toBe(true);
    expect(hasRichContent('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(hasRichContent('aGVsbG8gd29ybGQhIGFuZCBtb3JlIHRleHQgaGVyZQ==')).toBe(true);
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

describe('progressNote', () => {
  it('does not report the placeholder or a fake fraction before any tool ran', () => {
    for (let i = 0; i < 40; i++) {
      const note = progressNote({ elapsedMs: 30_000, summary: 'recibido', toolCalls: 0 });
      expect(note).not.toMatch(/recibido|mitad|casi|falta poco/i);
      expect(note).toContain('30 s');
      expect(note).toContain('pensando');
    }
  });

  it('says what the agent is doing once a tool started, with the elapsed time', () => {
    const note = progressNote({ elapsedMs: 125_000, summary: 'leyendo example.com', toolCalls: 2 });
    expect(note).toContain('2 min 5 s');
    expect(note).toContain('leyendo example.com');
  });

  it('never claims how much is left', () => {
    const seen = new Set(Array.from({ length: 200 }, () => progressMessage()));
    for (const phrase of seen) expect(phrase).not.toMatch(/mitad|casi|falta poco|proceso/i);
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

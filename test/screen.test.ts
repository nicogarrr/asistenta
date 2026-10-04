import { describe, expect, it } from 'vitest';
import {
  escapeForSendKeys,
  knownKeyNames,
  parseKeyChord,
  splitAsciiSegments,
} from '../src/screen/keys.js';
import {
  decodeEntities,
  extractText,
  isFetchable,
  isFetchableResolved,
  isPublicIp,
} from '../src/tools/fetch.js';

describe('parseKeyChord', () => {
  it('maps named keys', () => {
    expect(parseKeyChord('enter')).toBe('{ENTER}');
    expect(parseKeyChord('ENTER')).toBe('{ENTER}');
    expect(parseKeyChord(' escape ')).toBe('{ESC}');
    expect(parseKeyChord('f5')).toBe('{F5}');
  });

  it('combines modifiers', () => {
    expect(parseKeyChord('ctrl+s')).toBe('^s');
    expect(parseKeyChord('control+s')).toBe('^s');
    expect(parseKeyChord('ctrl+shift+p')).toBe('^+p');
    expect(parseKeyChord('alt+F4')).toBe('%{F4}');
    expect(parseKeyChord('ctrl+alt+delete')).toBe('^%{DELETE}');
  });

  it('accepts a single character as a chord', () => {
    expect(parseKeyChord('a')).toBe('a');
    expect(parseKeyChord('+')).toBe('{+}');
    expect(parseKeyChord('^')).toBe('{^}');
  });

  it('throws instead of leaking text for an unknown chord', () => {
    // The bug: `key("ctrlT")` used to be passed straight to SendKeys, which typed
    // the literal characters "ctrlT" into whatever had focus.
    expect(() => parseKeyChord('ctrlT')).toThrow(/unrecognised key/);
    expect(() => parseKeyChord('ctrl+nope')).toThrow(/unrecognised key/);
    expect(() => parseKeyChord('hyper+x')).toThrow(/unknown modifier/);
    expect(() => parseKeyChord('')).toThrow(/requires a chord/);
  });

  it('exposes its key names for error messages', () => {
    expect(knownKeyNames()).toContain('enter');
    expect(knownKeyNames()).toContain('delete');
  });
});

describe('escapeForSendKeys', () => {
  it('braces every metacharacter', () => {
    expect(escapeForSendKeys('a+b')).toBe('a{+}b');
    expect(escapeForSendKeys('100%')).toBe('100{%}');
    expect(escapeForSendKeys('a^b')).toBe('a{^}b');
    expect(escapeForSendKeys('(x)')).toBe('{(}x{)}');
    expect(escapeForSendKeys('C#')).toBe('C{#}');
  });

  it('turns newlines into explicit ENTER presses', () => {
    // A bare \n is SendKeys' escape prefix, so multi-line text became garbage.
    // N newlines produce N separators, never a trailing one.
    expect(escapeForSendKeys('one\ntwo')).toBe('one{ENTER}two');
    expect(escapeForSendKeys('a\r\nb\rc\nd')).toBe('a{ENTER}b{ENTER}c{ENTER}d');
    // Must survive as a real key press, not be re-braced into "{{}ENTER{}}", which
    // types the literal word ENTER.
    expect(escapeForSendKeys('one\ntwo')).not.toContain('{{}');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeForSendKeys('hola agent')).toBe('hola agent');
    expect(escapeForSendKeys('buscar Emphasis "barato"')).toBe('buscar Emphasis "barato"');
  });
});

describe('splitAsciiSegments', () => {
  it('keeps pure ASCII in one segment', () => {
    expect(splitAsciiSegments('hola agent')).toEqual([{ kind: 'ascii', text: 'hola agent' }]);
    expect(splitAsciiSegments('')).toEqual([]);
  });

  it('isolates emoji so only they go through the clipboard', () => {
    // "Hola ❤❤": the words type as keystrokes, the hearts paste.
    expect(splitAsciiSegments('Hola ❤❤')).toEqual([
      { kind: 'ascii', text: 'Hola ' },
      { kind: 'unicode', text: '❤❤' },
    ]);
  });

  it('keeps astral characters whole, not split into surrogates', () => {
    const segments = splitAsciiSegments('a😀b');
    expect(segments).toEqual([
      { kind: 'ascii', text: 'a' },
      { kind: 'unicode', text: '😀' },
      { kind: 'ascii', text: 'b' },
    ]);
    // A lone surrogate half would be a broken character; the emoji must survive.
    expect([...(segments[1]?.text ?? '')].length).toBe(1);
  });

  it('treats accented latin letters as unicode', () => {
    expect(splitAsciiSegments('creatina está bien')).toEqual([
      { kind: 'ascii', text: 'creatina est' },
      { kind: 'unicode', text: 'á' },
      { kind: 'ascii', text: ' bien' },
    ]);
  });
});

describe('isFetchable', () => {
  it('allows public http(s)', () => {
    expect(isFetchable('https://www.renfe.com/es/es')).toBe(true);
    expect(isFetchable('http://example.com')).toBe(true);
  });

  it('refuses local and private addresses', () => {
    // Otherwise the agent is a confused deputy against services that trust localhost.
    expect(isFetchable('http://localhost:8000/admin')).toBe(false);
    expect(isFetchable('http://127.0.0.1:5432')).toBe(false);
    expect(isFetchable('http://10.0.0.5/')).toBe(false);
    expect(isFetchable('http://192.168.1.1/')).toBe(false);
    expect(isFetchable('http://172.16.0.1/')).toBe(false);
    expect(isFetchable('http://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  it('refuses non-http schemes', () => {
    expect(isFetchable('file:///C:/Windows/System32/config')).toBe(false);
    expect(isFetchable('ftp://example.com')).toBe(false);
    expect(isFetchable('not a url')).toBe(false);
  });
});

describe('extractText', () => {
  it('drops scripts and styles', async () => {
    const html = `<html><head><style>body{color:red}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>Visible text</p></body></html>`;
    const text = await extractText(html, 'markdown');
    expect(text).toContain('Title');
    expect(text).toContain('Visible text');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color:red');
  });

  it('preserves heading and list structure in markdown', async () => {
    const html = '<h1>Buy</h1><h2>Price</h2><li>Item</li><strong>Now</strong>';
    const text = await extractText(html, 'markdown');
    expect(text).toContain('# Buy');
    expect(text).toContain('## Price');
    expect(text).toContain('- Item');
    expect(text).toContain('**Now**');
  });

  it('collapses runaway whitespace', async () => {
    const html = '<p>a</p><p></p><p></p><p>b</p>';
    const text = await extractText(html, 'text');
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeEntities('100&nbsp;&euro;')).toBe('100 €');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves unknown entities intact', () => {
    expect(decodeEntities('&notreal;')).toBe('&notreal;');
  });
});

describe('isPublicIp / isFetchableResolved', () => {
  it('classifies literal addresses, including mapped IPv6', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('2606:4700::1111')).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '100.64.0.1',
      '169.254.169.254',
      '::1',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0.0.0.0',
    ])
      expect(isPublicIp(ip)).toBe(false);
  });

  it('refuses a public-looking name that resolves to an internal address', async () => {
    const internal = async () => ['10.0.0.8'];
    const mixed = async () => ['93.184.216.34', '127.0.0.1'];
    const ok = async () => ['93.184.216.34'];
    expect(await isFetchableResolved('https://evil.example/x', internal)).toBe(false);
    expect(await isFetchableResolved('https://evil.example/x', mixed)).toBe(false);
    expect(await isFetchableResolved('https://good.example/x', ok)).toBe(true);
  });

  it('fails closed when the name does not resolve, and checks IP literals without DNS', async () => {
    const boom = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await isFetchableResolved('https://nope.example/', boom)).toBe(false);
    expect(await isFetchableResolved('http://[::ffff:127.0.0.1]/', boom)).toBe(false);
    expect(await isFetchableResolved('http://8.8.8.8/', boom)).toBe(true);
  });
});

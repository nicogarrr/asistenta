import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceSafe } from '../src/text.js';
import { plainVoiceError } from '../src/voice/plain-error.js';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('textos acortados sin medio emoji (bugs11)', () => {
  it('sliceSafe no deja medio emoji al final', () => {
    expect(sliceSafe('ab📄cd', 3)).toBe('ab');
    expect(sliceSafe('ab📄cd', 4)).toBe('ab📄');
    expect(sliceSafe('abc', 10)).toBe('abc');
    expect(sliceSafe('📄', 0)).toBe('');
  });

  it('un error de voz largo con emoji en el corte queda bien formado', () => {
    const msg = plainVoiceError(new Error(`${'x'.repeat(158)}🎤 y más texto que sobra`));
    expect(loneSurrogate.test(msg)).toBe(false);
    expect(msg.endsWith('…')).toBe(true);
  });

  it('nadie en src acorta con «x.slice(0, n)» + «…» a ciegas (usa sliceSafe)', () => {
    const offenders = tsFiles(join(__dirname, '..', 'src')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ file, line: i + 1, text: line }))
        .filter((l) => /\.slice\(0, [^)]*\)\}…/.test(l.text))
        .map((l) => `${l.file.split(/[\\/]src[\\/]/).pop()}:${l.line}`),
    );
    expect(offenders).toEqual([]);
  });
});

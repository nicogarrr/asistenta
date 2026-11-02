import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCommandCursor, saveCommandCursor } from '../src/mail/command-inbox.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'cmdcursor-')), 'cursor.json');

describe('cursor del buzón de comandos', () => {
  it('guarda y lee la posición', () => {
    const file = tmpFile();
    saveCommandCursor(file, { validity: '7', next: 104 });
    expect(loadCommandCursor(file)).toEqual({ validity: '7', next: 104 });
  });

  it('sin fichero arranca de cero (final del buzón)', () => {
    expect(loadCommandCursor(tmpFile())).toBeNull();
  });

  it('un cursor corrupto se aparta con su contenido en vez de perderse', () => {
    const file = tmpFile();
    writeFileSync(file, '{roto', 'utf8');
    expect(loadCommandCursor(file)).toBeNull();
    expect(existsSync(file)).toBe(false);
    const aside = readdirSync(dirname(file)).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dirname(file), aside[0] as string), 'utf8')).toBe('{roto');
  });

  it('un JSON válido pero sin la forma del cursor también se aparta', () => {
    const file = tmpFile();
    writeFileSync(file, '{"otra":"cosa"}', 'utf8');
    expect(loadCommandCursor(file)).toBeNull();
    expect(existsSync(file)).toBe(false);
    const aside = readdirSync(dirname(file)).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
  });
});

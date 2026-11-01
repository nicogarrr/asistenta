import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows PowerShell 5.1 lee un .ps1 sin BOM como ANSI: «Instalación» sale
// como «InstalaciÃ³n». Todo .ps1 con letras no ASCII debe llevar BOM UTF-8.
const ROOTS = ['deploy', 'scripts'];

function ps1Files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...ps1Files(p));
    else if (/\.ps(m)?1$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => ps1Files(resolve(r)));

describe('scripts de PowerShell', () => {
  it('hay scripts que revisar', () => {
    expect(files.some((f) => f.endsWith(join('windows', 'install-all.ps1')))).toBe(true);
  });

  it('los que tienen tildes o símbolos llevan BOM UTF-8 (PowerShell 5.1)', () => {
    const sinBom = files.filter((f) => {
      const buf = readFileSync(f);
      const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      return !bom && buf.some((b) => b > 0x7f);
    });
    expect(sinBom.map((f) => relative(process.cwd(), f))).toEqual([]);
  });

  it('el BOM no va duplicado y el resto es UTF-8 válido', () => {
    for (const f of files) {
      const buf = readFileSync(f);
      expect(buf.subarray(3, 6).equals(Buffer.from([0xef, 0xbb, 0xbf])), f).toBe(false);
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(buf), f).not.toThrow();
    }
  });
});

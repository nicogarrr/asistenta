import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trimForSpeech } from '../src/daemon/speech-text.js';
import { normalizeMessage } from '../src/diagnose.js';
import { workspaceTools } from '../src/evolve/battery-case.js';
import { firstStderrLine } from '../src/screen/ocr.js';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cortes sin medio emoji, tercera ola (bugs13)', () => {
  it('trimForSpeech: un tope sin frases ni espacios no parte un emoji', () => {
    // 899 letras + emoji en el corte de 900 (sin fin de frase ni espacio antes).
    const out = trimForSpeech(`${'a'.repeat(899)}🎉${'b'.repeat(50)}`);
    expect(loneSurrogate.test(out)).toBe(false);
  });

  it('normalizeMessage: el resumen de un error no parte un emoji', () => {
    const out = normalizeMessage(`${'x'.repeat(239)}🎉 boom`);
    expect(loneSurrogate.test(out)).toBe(false);
  });

  it('firstStderrLine: la línea de un script roto no parte un emoji', () => {
    const out = firstStderrLine(`${'x'.repeat(239)}🎉 boom\notra línea`);
    expect(loneSurrogate.test(out)).toBe(false);
  });

  it('el read de la batería no manda medio emoji al modelo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-bugs13-'));
    try {
      writeFileSync(join(dir, 'nota.txt'), `${'a'.repeat(21_999)}🎉${'b'.repeat(100)}`);
      const read = workspaceTools(dir).find((t) => t.name === 'read');
      const out = (await read?.execute('t1', { path: 'nota.txt' })) as {
        content: { text: string }[];
      };
      const text = out.content[0]?.text ?? '';
      expect(loneSurrogate.test(text)).toBe(false);
      expect([...text].length).toBeLessThanOrEqual(22_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('factory: ningún texto del guest se corta a ciegas', () => {
    const runner = readFileSync(join(__dirname, '..', 'src', 'factory', 'runner.ts'), 'utf8');
    const loader = readFileSync(join(__dirname, '..', 'src', 'factory', 'loader.ts'), 'utf8');
    // En el guest no hay sliceSafe: el corte se sanea con la regex de par sustituto.
    const blind = /\.slice\(0, \d[\d_]*\)(?!\.replace\()/;
    for (const line of runner.split('\n')) {
      if (!line.includes('.slice(0,')) continue;
      expect(blind.test(line), `runner: ${line.trim()}`).toBe(false);
    }
    for (const line of loader.split('\n')) {
      if (!line.includes('.slice(0,')) continue;
      expect(line.includes('sliceSafe'), `loader: ${line.trim()}`).toBe(true);
    }
  });
});

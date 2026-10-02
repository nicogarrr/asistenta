import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  buildLanguagesScript,
  buildOcrScript,
  formatOcr,
  type OcrResult,
  ocrAvailable,
  ocrImage,
} from '../src/screen/ocr.js';

const execFileAsync = promisify(execFile);

function line(
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
): OcrResult['lines'][0] {
  return {
    text,
    x,
    y,
    width,
    height,
    words: [{ text, x, y, width, height }],
  };
}

function result(lines: OcrResult['lines']): OcrResult {
  return {
    lines,
    text: lines.map((l) => l.text).join('\n'),
    language: 'es-ES',
    width: 1234,
    height: 823,
  };
}

describe('formatOcr', () => {
  it('puts the position and a clickable point on every line', () => {
    // The format is the whole value of the tool. A list of strings is something the
    // model has to match against a picture it cannot measure; a list of lines with a
    // ready-made coordinate is an instruction it can follow without guessing.
    const out = formatOcr(
      result([line('Archivo', 200, 540, 28, 40), line('HOLA MUNDO', 100, 100, 400, 60)]),
    );
    expect(out).toContain('y=540 "Archivo" (clic 214,560)');
    expect(out).toContain('y=100 "HOLA MUNDO" (clic 300,130)');
    expect(out).toContain('1234x823');
    expect(out).toContain('es-ES');
    // Reading order, not geometric order: OCR lines are not sorted by y, and a UI whose
    // toolbar is at the top of the list must not be printed in the middle of the output.
    expect(out.indexOf('y=540')).toBeLessThan(out.indexOf('y=100'));
  });

  it('explains what the click point is instead of leaving the model to work it out', () => {
    const out = formatOcr(result([line('Guardar', 0, 0, 10, 10)]));
    expect(out).toMatch(/centro del texto/);
    expect(out).toMatch(/sin escalarlo/);
  });

  it('keeps the output on one line per OCR line', () => {
    // A newline inside a line would make the model count rows it cannot see, and the
    // whole point is a one-to-one map between printed lines and clickable things.
    const out = formatOcr(result([line('multi\nline  texto', 0, 0, 20, 20)]));
    const row = out.split('\n').filter((l) => l.startsWith('y='));
    expect(row).toHaveLength(1);
    expect(row[0]).toBe('y=0 "multi line texto" (clic 10,10)');
  });

  it('says how many lines it dropped instead of truncating silently', () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(`linea ${i}`, 0, i * 20, 100, 16));
    const out = formatOcr(result(lines), { maxLines: 5 });
    expect(out).toContain('y=0 "linea 0"');
    expect(out).toContain('y=80 "linea 4"');
    expect(out).not.toContain('linea 5"');
    expect(out).toContain('25 lineas mas');
    expect(out).toMatch(/ATENCI/);
  });

  it('states the character cut rather than ending mid-word without saying so', () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      line(`una linea larguisima ${i}`, 0, i * 20, 100, 16),
    );
    const out = formatOcr(result(lines), { maxLines: 40, maxChars: 200 });
    expect(out.length).toBeLessThan(600);
    expect(out).toMatch(/SALTO.*caracteres/);
  });

  it('never returns a bounded option that silently produces nothing', () => {
    // A zero or negative limit is a mistake, not an instruction. Returning an empty
    // body would read to the model as "there is no text on the screen", which is the
    // one conclusion that must never be reached by accident.
    const out = formatOcr(result([line('texto', 0, 0, 10, 10)]), { maxLines: 0, maxChars: 1 });
    expect(out).toContain('"texto"');
  });

  it('explains an empty result without claiming the screen is blank', () => {
    // "No text" has two very different causes — no text, or no OCR — and the model acts
    // oppositely on each, so the message points at the second instead of asserting the
    // first.
    const out = formatOcr(result([]));
    expect(out).toMatch(/0 lineas/);
    expect(out).toMatch(/No ha salido texto/);
    expect(out).toMatch(/windows/);
  });
});

describe('ocr availability', () => {
  it('answers with a boolean and never throws, even without an engine', async () => {
    // Checked at startup to decide whether to offer the tool at all. A throw here would
    // surface as an unhandled tool error in the middle of a turn, which is the worst
    // possible moment to discover the machine cannot OCR.
    const available = await ocrAvailable();
    expect(typeof available).toBe('boolean');
  }, 25_000);
});

describe('powershell scripts', () => {
  it('passes the image path as base64 rather than as text in the script', () => {
    // Windows PowerShell 5.1 reads a `-Command` string as the console's own ANSI code
    // page, so a path with an accent in it arrives mangled and StorageFile then reports
    // a file that does not exist. The failure is invisible for ASCII paths, which is why
    // it has to be asserted here instead of being discovered by a user called `Begoña`.
    const script = buildOcrScript(
      Buffer.from('C:\\Users\\Begoña\\captura.png', 'utf8').toString('base64'),
    );
    expect(script).toContain(
      Buffer.from('C:\\Users\\Begoña\\captura.png', 'utf8').toString('base64'),
    );
    expect(script).not.toContain('Begoña');
    expect(script).toContain('FromBase64String');
  });

  it('asks for Spanish before falling back to the profile languages', () => {
    // Asserted as a script shape, not as OCR output, because the fallback only shows up
    // on a machine without the Spanish pack, and a test that can only run on one
    // configuration is a test that stops running the day the configuration changes.
    for (const script of [buildOcrScript('AA=='), buildLanguagesScript()]) {
      expect(script.indexOf("'es-ES'")).toBeLessThan(
        script.indexOf('TryCreateFromUserProfileLanguages'),
      );
      expect(script).toContain('AvailableRecognizerLanguages');
    }
  });

  it('enumerates the result instead of indexing it', () => {
    // `$result.Lines[0]` does not fail loudly: it hands back the whole raw collection,
    // and the mistake only surfaces three expressions later as an Object[] cast error.
    // Asserting the absence of the indexer keeps that from coming back.
    expect(buildOcrScript('AA==')).toContain('foreach ($PaLine in $PaResult.Lines)');
    expect(buildOcrScript('AA==')).not.toMatch(/\$PaResult\.Lines\[/);
  });
});

/**
 * End to end against a real image painted by System.Drawing.
 *
 * The image is generated rather than checked in because the thing being tested is
 * Windows' OCR engine on this machine, and a fixture would only prove that an engine once
 * read a file. Every value in it is also positioned on purpose: the assertion is on the
 * bounding box, since a bounding box that is zero or outside the image is exactly what
 * makes the tool useless while still returning text.
 */
describe('ocr end to end (live)', () => {
  it('reads a painted image and places the text inside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-ocr-'));
    const image = join(dir, 'ocr-test.png');
    try {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900, 400
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 20, 20, 20))
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.DrawString('HOLA MUNDO', (New-Object System.Drawing.Font 'Segoe UI', 64), $white, 60, 50)
$g.DrawString('Guardar', (New-Object System.Drawing.Font 'Segoe UI', 40), $white, 60, 200)
$g.Dispose()
$bmp.Save('${image.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`,
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(existsSync(image)).toBe(true);

      if (!(await ocrAvailable())) {
        // Not a skip. The graceful path is the behaviour that matters on a machine
        // without the Spanish pack, and a silent `skip` here would let that path rot
        // while the suite stayed green.
        await expect(ocrImage(image)).rejects.toThrow(/OCR de Windows/);
        return;
      }

      const r = await ocrImage(image);
      // Tolerant on case and spacing because the recognizer is free to report a word
      // split differently; what is being asserted is that the glyphs were read, not how.
      expect(r.text.replace(/\s+/g, ' ').toUpperCase()).toContain('HOLA');
      expect(r.text).toMatch(/Guardar/);
      expect(r.width).toBe(900);
      expect(r.height).toBe(400);
      expect(r.language).toMatch(/^[a-z]{2}(-[A-Za-z0-9]+)?$/);

      const hola = r.lines.find((l) => l.text.replace(/\s+/g, ' ').toUpperCase().includes('HOLA'));
      expect(hola).toBeDefined();
      // A line box that is degenerate or off the image is the failure that still returns
      // text, so it gets its own assertion rather than riding along with the text check.
      expect(hola?.width ?? 0).toBeGreaterThan(0);
      expect(hola?.height ?? 0).toBeGreaterThan(0);
      expect(hola?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect(hola?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((hola?.x ?? 0) + (hola?.width ?? 0)).toBeLessThanOrEqual(900);
      expect((hola?.y ?? 0) + (hola?.height ?? 0)).toBeLessThanOrEqual(400);

      // Per-word boxes are the actual product of this tool.
      const words = hola?.words ?? [];
      expect(words.length).toBeGreaterThan(0);
      for (const w of words) {
        expect(w.width).toBeGreaterThan(0);
        expect(w.height).toBeGreaterThan(0);
        expect(w.text.length).toBeGreaterThan(0);
      }

      const formatted = formatOcr(r);
      expect(formatted).toMatch(/y=\d+ "HOLA MUNDO" \(clic \d+,\d+\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('ocr failure paths', () => {
  it('rejects a missing image before spending a PowerShell round trip on it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-ocr-'));
    try {
      await expect(ocrImage(join(dir, 'not-here.png'))).rejects.toThrow(/no encuentro la imagen/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an undecodable file in Spanish rather than as a COM exception', async () => {
    // The raw failure for this is "Exception from HRESULT: 0x88982F07" three frames
    // deep, which says nothing about the fix. The file is named .png and is not one,
    // which is exactly what a half-written screenshot or a wrong screenshot path looks
    // like in practice.
    const dir = mkdtempSync(join(tmpdir(), 'pa-ocr-'));
    const fake = join(dir, 'fake.png');
    try {
      rmSync(fake, { force: true });
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Set-Content -LiteralPath '${fake.replace(/'/g, "''")}' -Value 'esto no es una imagen' -Encoding ASCII`,
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      if (!(await ocrAvailable())) return;
      await expect(ocrImage(fake)).rejects.toThrow(/no he podido decodificar la imagen/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

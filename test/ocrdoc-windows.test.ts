import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ocrPdf, ocrPhoto } from '../src/ocrdoc/engine.js';
import { digitalPagesPdfjs, windowsDeps } from '../src/ocrdoc/windows.js';
import { ocrAvailable } from '../src/screen/ocr.js';
import { isWindows } from './helpers/platform.js';

/**
 * Prueba REAL en Windows con imagen sintetica (texto negro sobre blanco dibujado con
 * System.Drawing; nada privado): Windows.Data.Pdf renderiza, Windows.Media.Ocr reconoce y
 * pdf-lib superpone la capa. Salta fuera de Windows; en Windows NO se salta nunca.
 */
describe.skipIf(!isWindows)('ocrdoc en Windows real (sintetico)', () => {
  it('PDF escaneado sintetico -> texto buscable; foto sintetica -> PDF buscable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-ocrdoc-win-'));
    try {
      const image = join(dir, 'scan.png');
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1240, 1754
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Black)
$f = New-Object System.Drawing.Font 'Arial', 36
$g.DrawString('FACTURA NUMERO 2024', $f, $b, 100, 200)
$g.DrawString('TOTAL 123 EUROS', $f, $b, 100, 400)
$g.Dispose()
$bmp.Save('${image.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      const png = readFileSync(image);
      expect(await ocrAvailable(), 'el OCR de Windows no esta disponible en este equipo').toBe(
        true,
      );

      // 1) PDF escaneado: una pagina A4 con la imagen
      const doc = await PDFDocument.create();
      const img = await doc.embedPng(png);
      doc.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
      const input = await doc.save();
      expect((await digitalPagesPdfjs(input))[0]?.trim()).toBe('');
      const r = await ocrPdf(input, 'sintetico.pdf', windowsDeps(dir));
      // Diagnostico: motivo por pagina si algo falla
      expect(JSON.stringify(r.pages), 'informe por pagina').toContain('"source":"ocr"');
      const text = (await digitalPagesPdfjs(r.pdf as Uint8Array))[0] ?? '';
      expect(text.toUpperCase()).toContain('FACTURA');
      expect(text.toUpperCase()).toContain('123');
      console.log('WINDOWS_OCR_PDF_TEXT', JSON.stringify(text.slice(0, 120)));
      console.log('WINDOWS_OCR_PAGES', JSON.stringify(r.pages));

      // 2) foto
      const p = await ocrPhoto(png, 'image/png', 'foto.png', windowsDeps(dir));
      const t2 = (await digitalPagesPdfjs(p.pdf as Uint8Array))[0] ?? '';
      expect(t2.toUpperCase()).toContain('TOTAL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

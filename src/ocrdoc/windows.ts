import { stat } from 'node:fs/promises';
import { b64, firstStderrLine, ocrImage, ps, WINRT_BRIDGE } from '../screen/ocr.js';
import type { EngineDeps } from './engine.js';

/**
 * Piezas que dependen de Windows (render de PDF con Windows.Data.Pdf y OCR de
 * Windows.Media.Ocr, ambos incluidos en el sistema, sin instalar nada) y la lectura del
 * texto propio de cada página con pdfjs, que corre en cualquier sistema.
 *
 * NO VERIFICADO en Windows real: el script de render sigue el mismo puente WinRT que el OCR
 * de pantalla, pero en el entorno de desarrollo (Linux) solo se puede probar con dobles.
 * La primera prueba real con un PDF escaneado tiene que hacerse en Windows.
 */

/** Ancho de render: ~300 ppp en un A4 (8,27 in), el punto dulce del OCR de Windows. */
export const RENDER_WIDTH_PX = 2480;
const RENDER_TIMEOUT_MS = 90_000;

export function buildRenderScript(
  pdfPathB64: string,
  pageIndex: number,
  outPathB64: string,
  widthPx: number,
): string {
  const idx = Math.max(0, Math.floor(pageIndex));
  const w = Math.max(200, Math.floor(widthPx));
  return `${WINRT_BRIDGE}
try {
  foreach ($t in @('Windows.Data.Pdf.PdfDocument','Windows.Data.Pdf.PdfPageRenderOptions')) {
    if ($null -eq [Type]::GetType($t + ', Windows.Data.Pdf, ContentType=WindowsRuntime')) {
      Write-Output ('PAOCR!ERR|WINRT|' + (PaB64 $t))
      exit 0
    }
  }
  $PaAsAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]
  $PaPdf = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${pdfPathB64}'))
  $PaOutPng = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${outPathB64}'))
  $PaFile = PaAwait ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PaPdf)) ([Windows.Storage.StorageFile])
  $PaDoc = PaAwait ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($PaFile)) ([Windows.Data.Pdf.PdfDocument])
  if ($PaDoc.IsPasswordProtected) {
    Write-Output ('PAOCR!ERR|FAILED|' + (PaB64 'PDF protegido con contrasena'))
    exit 0
  }
  if (${idx} -ge $PaDoc.PageCount) {
    Write-Output ('PAOCR!ERR|FAILED|' + (PaB64 'pagina fuera de rango'))
    exit 0
  }
  $PaPage = $PaDoc.GetPage(${idx})
  $PaOpts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $PaOpts.DestinationWidth = ${w}
  $PaMem = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $PaTask = $PaAsAction.Invoke($null, @($PaPage.RenderToStreamAsync($PaMem, $PaOpts)))
  try { $PaTask.Wait(-1) | Out-Null } catch [System.AggregateException] { throw $PaTask.Exception.GetBaseException() }
  $PaMem.Seek(0)
  $PaIn = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($PaMem)
  $PaFs = [System.IO.File]::Create($PaOutPng)
  try { $PaIn.CopyTo($PaFs) } finally { $PaFs.Dispose(); $PaIn.Dispose() }
  $PaPage.Dispose()
  Write-Output 'PAOCR!OK|'
} catch {
  Write-Output ('PAOCR!ERR|FAILED|' + (PaB64 ([string]$_.Exception.GetType().Name + ': ' + [string]$_.Exception.Message)))
}
`;
}

export async function renderPageWindows(
  pdfPath: string,
  pageIndex: number,
  outPng: string,
): Promise<void> {
  const script = buildRenderScript(b64(pdfPath), pageIndex, b64(outPng), RENDER_WIDTH_PX);
  const { stdout, stderr } = await ps(script, RENDER_TIMEOUT_MS);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PAOCR!'));
  if (!line) throw new Error(firstStderrLine(stderr) || 'el render de Windows no devolvió nada');
  if (line.startsWith('PAOCR!ERR|')) {
    const parts = line.split('|');
    const detail = parts[2]
      ? Buffer.from(parts[2], 'base64').toString('utf8')
      : (parts[1] ?? 'error');
    throw new Error(`no se pudo renderizar la página: ${detail}`.slice(0, 200));
  }
  const info = await stat(outPng).catch(() => null);
  if (!info || info.size === 0) throw new Error('el render no produjo imagen');
}

interface PdfjsPage {
  getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
  cleanup(): void;
}
interface PdfjsDoc {
  numPages: number;
  getPage(n: number): Promise<PdfjsPage>;
}
export interface PdfjsModule {
  getDocument(opts: { data: Uint8Array }): { promise: Promise<PdfjsDoc>; destroy(): Promise<void> };
}

/** Texto propio de cada página. pdfjs se carga al primer PDF (pesa ~5 MB). */
export async function digitalPagesPdfjs(
  bytes: Uint8Array,
  loader: () => Promise<PdfjsModule> = async () =>
    (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule,
): Promise<string[]> {
  const pdfjs = await loader();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  try {
    const doc = await task.promise;
    const out: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      out.push(content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : ' ')).join(''));
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy().catch(() => {});
  }
}

export function windowsDeps(workDir: string): EngineDeps {
  if (process.platform !== 'win32') {
    return {
      digitalPages: (b) => digitalPagesPdfjs(b),
      workDir,
      noOcrReason: 'el OCR de este equipo solo funciona en Windows',
    };
  }
  return {
    digitalPages: (b) => digitalPagesPdfjs(b),
    renderPage: renderPageWindows,
    ocr: ocrImage,
    workDir,
  };
}

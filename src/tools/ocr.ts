import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { formatOcr, ocrImage } from '../screen/ocr.js';

const Params = Type.Object({
  action: Type.Literal('screen'),
  maxLines: Type.Optional(
    Type.Number({
      description: 'Max OCR lines to return. Default 120. Truncation is always stated.',
    }),
  ),
});

/**
 * Read the text on the screen, with the position of every word.
 *
 * This exists because of a specific, measured failure. The vision model driving this
 * agent reads the screenshot well enough to know a button is there and badly enough to
 * miss what it says, and then it cannot click it: the only way to act on a control you
 * can see but cannot read is to guess, and the guess is a coordinate. On GUI benchmarks
 * that guessing is the difference between finishing and looping. So the button becomes
 * "Guardar" at 214,540, which is a fact rather than an estimate.
 *
 * Windows' own OCR engine supplies that text for free — it is the one behind Snipping
 * Tool's "Text actions", it runs offline, and it costs nothing per call. There is no
 * model to download, no API key, and no per-step token bill, which is why this is a tool
 * and not a prompt instruction to look more carefully.
 *
 * The image is returned alongside the text and that is not a convenience. The model still
 * needs the picture: OCR reads text and knows nothing about layout, icons, disabled
 * state, or which of two identical labels is the live one. The text tells it what to
 * look for and where; the image tells it what it is looking at. Sending only the text
 * produces confident clicks on the wrong control, which is the failure this tool exists
 * to remove.
 *
 * Screen capture is injected rather than reimplemented. `WindowsScreen` already owns the
 * DPI-aware capture, the downscaling and the temp-directory lifetime, and a second
 * capture path would be a second set of coordinates that could disagree with the first —
 * the exact bug the DPI correction in `windows.ts` was written to kill.
 */
export function createOcrTool(deps: {
  screenshotToFile: () => Promise<string>;
  ocrAvailable: () => Promise<boolean>;
}): AgentTool<typeof Params> {
  return {
    name: 'ocr',
    label: 'OCR',
    description: [
      'Read the text that is on the screen right now, with the exact position of every word.',
      '',
      'Use it when you can SEE that there is text on screen but cannot read it confidently,',
      'or when you need to know what a particular control says before clicking it. Reading the',
      'screenshot yourself is usually enough to know a dialog is open; it is usually not enough',
      'to know whether the button says "Guardar" or "Guardado".',
      '',
      'The result gives every line as y=<vertical position> "text" (click <x,y>). Use the click',
      'point as the coordinates of the computer tool click action, without scaling them. This is',
      'strictly more reliable than estimating a position from the picture.',
      '',
      'You also get the screenshot back, so you can see the layout while reading the text: OCR',
      'knows nothing about icons, disabled buttons, or which of two similar labels is the real',
      'one. Use the text to identify the element and the image to confirm it.',
      '',
      'Cost: one extra screenshot and about a second. Worth it whenever a wrong click would',
      'cost a step. It needs an OCR language pack installed in Windows (Spanish or English).',
    ].join(' '),
    parameters: Params,
    // Sequential: it captures the screen, and two captures in one batch can straddle a
    // repaint, which would report text for a state that no longer exists.
    executionMode: 'sequential',
    execute: async (_id, args) => {
      if (args.action !== 'screen') {
        throw new Error(`accion desconocida: ${String(args.action)}`);
      }

      if (!(await deps.ocrAvailable())) {
        return {
          content: [
            {
              type: 'text',
              text:
                'El OCR de Windows no esta disponible en este PC: no hay ningun motor de OCR instalado ' +
                'para ningun idioma. Anadelo en Ajustes > Hora e idioma > Idioma > Opciones > "Optical ' +
                'character recognition" (el paquete de espanol o el de ingles). Mientras tanto, lee el ' +
                'texto de la captura con la vista, o usa el tool windows para ver el arbol de controles.',
            },
          ],
          details: { available: false },
        };
      }

      const file = await deps.screenshotToFile();
      // Resolved before the OCR, because the catch below has to reuse it when the image
      // is the one thing that still works.
      const mimeType = mimeFor(file);
      try {
        const image = await readFile(file);
        const result = await ocrImage(file);
        const text = formatOcr(result, { maxLines: Math.trunc(Number(args.maxLines ?? 120)) });
        log.info('ocr', {
          lines: result.lines.length,
          language: result.language,
          bytes: image.length,
        });
        return {
          content: [
            { type: 'text', text },
            { type: 'image', mimeType, data: image.toString('base64') },
          ],
          details: {
            available: true,
            language: result.language,
            width: result.width,
            height: result.height,
            lines: result.lines.length,
          },
        };
      } catch (err) {
        // The screenshot is still worth returning when the OCR failed: the model can read
        // it with its own vision, which is exactly the fallback this tool is layered on
        // top of. Dropping it would turn "no text engine" into "I am blind".
        const why = err instanceof Error ? err.message : String(err);
        log.warn('ocr failed', { err });
        const image = await readFile(file).catch(() => null);
        const message = `No he podido hacer OCR de la pantalla: ${why}`;
        return {
          content: image
            ? [
                { type: 'text' as const, text: message },
                { type: 'image' as const, mimeType, data: image.toString('base64') },
              ]
            : [{ type: 'text' as const, text: message }],
          details: { available: true, ok: false, error: why },
        };
      }
    },
  };
}

/**
 * Mime type from the file extension, not assumed.
 *
 * A mismatch here is not cosmetic: the provider is told the image is a JPEG and handed
 * PNG bytes, and the refusal comes back as an opaque 400 from the model API that never
 * mentions screenshots or OCR. JPEG is the default because that is what
 * `screenshotToFile` is contracted to write, not because PNG is unlikely.
 */
function mimeFor(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

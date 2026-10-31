/**
 * Plugin del OCR local (opcional, apagado por defecto). Mismo patrón que la tele y el
 * iPhone (src/plugins/tv.ts, iphone.ts): el cableado vive aquí y cli.ts solo lo registra.
 *
 * Sin PA_OCR_LOCAL=1 no aporta ninguna tool: nada se ofrece al modelo ni se arranca.
 */
import { basename, dirname, extname, join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { REPO_DIR } from '../paths.js';
import { renderPdfPages, type SavedPage } from '../pdfmd/render.js';
import { checkPages, splitPages, tableNote } from '../pdfmd/verify.js';
import {
  type OcrModel,
  resolveOcrPath,
  runOcrSidecar,
  type SidecarResult,
} from '../tools/ocr-local.js';
import type { CapabilityPlugin } from './types.js';

export const OCR_LOCAL_DISABLED = 'OCR local desactivado: PA_OCR_LOCAL=1';
export const OCR_MAX_TEXT_CHARS = 20_000;
export const OCR_SIDECAR_DIR = join(REPO_DIR, 'scripts', 'ocr-sidecar');

export function ocrLocalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PA_OCR_LOCAL?.trim() === '1';
}

/** PA_OCR_MODEL: vacío o «ppocr» → PP-OCRv5; «glm» → GLM-OCR; otra cosa → null. */
export function ocrModelFromEnv(env: NodeJS.ProcessEnv = process.env): OcrModel | null {
  const v = (env.PA_OCR_MODEL ?? '').trim().toLowerCase();
  if (v === '' || v === 'ppocr') return 'ppocr';
  if (v === 'glm') return 'glm';
  return null;
}

export interface OcrLocalDeps {
  env?: NodeJS.ProcessEnv;
  roots: () => string[];
  run: (model: OcrModel, file: string) => Promise<SidecarResult>;
  /** Guarda páginas del PDF como PNG (por defecto pdfjs); inyectable en tests. */
  renderPages?: (pdf: string, pages: number[], outDir: string) => Promise<SavedPage[]>;
}

/**
 * Nada se pierde (idea de pdf2md, MIT): las páginas de un PDF sin texto o con una tabla
 * sin comprobar se guardan como imagen junto al PDF y se enlazan al final del texto.
 */
async function keepEvidence(
  file: string,
  body: string,
  badPages: number[],
  render: NonNullable<OcrLocalDeps['renderPages']>,
): Promise<string> {
  if (extname(file).toLowerCase() !== '.pdf') return '';
  const parts = splitPages(body);
  const empty = parts.length > 1 ? parts.filter((p) => !p.text.trim()).map((p) => p.page) : [];
  const pages = [...new Set([...badPages, ...empty])].sort((a, b) => a - b);
  if (pages.length === 0) return '';
  const folder = `${basename(file, extname(file))}-paginas`;
  const saved = await render(file, pages, join(dirname(file), folder));
  if (saved.length === 0) return '';
  const list = saved.map((p) => `![Página ${p.page} del original](${folder}/${basename(p.file)})`);
  const which = saved.map((p) => p.page).join(', ');
  return [
    `He guardado como imagen ${saved.length === 1 ? 'la página' : 'las páginas'} ${which} junto al PDF, para que no se pierda nada:`,
    ...list,
  ].join('\n');
}

const Params = Type.Object({
  path: Type.String({ description: 'Ruta de una imagen (png, jpg, webp, bmp, tif) o un PDF.' }),
});

const text = (t: string) => ({ type: 'text' as const, text: t });

export function createOcrLocalTool(deps: OcrLocalDeps): AgentTool<typeof Params> {
  return {
    name: 'ocr_local',
    label: 'OCR local',
    description: [
      'Saca el texto de una imagen o un PDF escaneado del disco con un motor OCR local',
      '(PP-OCRv5 por defecto, GLM-OCR si PA_OCR_MODEL=glm). Sin red ni coste por llamada.',
      'Solo lee ficheros dentro de las carpetas permitidas. Para el texto de la pantalla usa `ocr`.',
    ].join(' '),
    parameters: Params,
    execute: async (_id, args) => {
      const env = deps.env ?? process.env;
      if (!ocrLocalEnabled(env)) return { content: [text(OCR_LOCAL_DISABLED)], details: {} };
      const model = ocrModelFromEnv(env);
      if (!model) {
        return {
          content: [text(`PA_OCR_MODEL=${env.PA_OCR_MODEL} no vale: usa ppocr o glm.`)],
          details: {},
        };
      }
      const file = await resolveOcrPath(args.path, deps.roots());
      const r = await deps.run(model, file);
      const body = r.text.trim();
      if (!body)
        return {
          content: [text('No he encontrado texto en ese fichero.')],
          details: { model, pages: r.pages },
        };
      const cut = body.length > OCR_MAX_TEXT_CHARS;
      const shown = cut ? body.slice(0, OCR_MAX_TEXT_CHARS) : body;
      const note = cut ? `\n\n[recortado: ${OCR_MAX_TEXT_CHARS} de ${body.length} caracteres]` : '';
      // Tablas comprobadas sin IA (idea de pdf2md, MIT): si no cuadran, se avisa.
      const check = checkPages(body);
      const warn = tableNote(check.issues, splitPages(body).length > 1);
      const kept = await keepEvidence(
        file,
        body,
        check.issues.map((x) => x.page),
        deps.renderPages ?? renderPdfPages,
      );
      const tail = [warn, kept].filter(Boolean).join('\n\n');
      return {
        content: [text(shown + note + (tail ? `\n\n${tail}` : ''))],
        details: {
          model,
          pages: r.pages,
          truncated: cut,
          tables: check.tables,
          tablesUnverified: check.issues.length,
        },
      };
    },
  };
}

/** El Python del venv que crea setup.ps1 / setup.sh, o PA_OCR_PYTHON si se indica. */
export function ocrPython(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  const own = env.PA_OCR_PYTHON?.trim();
  if (own) return own;
  return platform === 'win32'
    ? join(OCR_SIDECAR_DIR, '.venv', 'Scripts', 'python.exe')
    : join(OCR_SIDECAR_DIR, '.venv', 'bin', 'python');
}

/** Carpetas legibles: la de trabajo (como `read`) y la carpeta vigilada de OCR si existe. */
export function ocrRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const watch = env.PA_OCR_WATCH_DIR?.trim();
  return watch ? [process.cwd(), watch] : [process.cwd()];
}

export const ocrLocalPlugin: CapabilityPlugin<{ env?: NodeJS.ProcessEnv }> = {
  id: 'ocr_local',
  tools: ({ env = process.env } = {}) =>
    ocrLocalEnabled(env)
      ? [
          createOcrLocalTool({
            env,
            roots: () => ocrRoots(env),
            run: (model: OcrModel, file: string) =>
              runOcrSidecar({
                python: ocrPython(env),
                script: join(OCR_SIDECAR_DIR, 'ocr_sidecar.py'),
                model,
                file,
              }),
          }),
        ]
      : [],
};

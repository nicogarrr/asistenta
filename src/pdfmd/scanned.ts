/**
 * «resume este PDF» con un PDF escaneado: el PDF no trae texto, así que primero se lee con el
 * mismo OCR local que «/ocr md» y el texto queda en la memoria documental para que el modelo
 * conteste. Las tablas se comprueban sin IA (idea de pdf2md, https://github.com/Ntizar/pdf2md,
 * MIT) y, si alguna no cuadra, la nota se lo dice al modelo para que avise.
 */
import type { OcrJobResult, OcrMode } from '../ocrdoc/job.js';
import { describeIssues, verifyTables } from './tables.js';

export interface ScannedDeps {
  /** ¿Hay OCR local en este PC? */
  available: () => Promise<boolean>;
  run: (bytes: Buffer, meta: { name?: string }, mode: OcrMode) => Promise<OcrJobResult>;
  /** Guarda el texto en la memoria documental; null si no había nada que guardar. */
  index: (text: string) => { chars: number; truncated?: boolean } | null;
}

/** Nota para el modelo, o null si no se pudo leer (se queda la nota de siempre). */
export async function ocrScannedForModel(
  bytes: Buffer,
  label: string,
  deps: ScannedDeps,
): Promise<string | null> {
  if (!(await deps.available().catch(() => false))) return null;
  const r = await deps.run(bytes, { name: label }, 'md').catch(() => null);
  if (!r?.ok) return null;
  const md = r.files.find((f) => f.filename.endsWith('.md'))?.bytes.toString('utf8') ?? '';
  if (!md.trim()) return null;
  const indexed = deps.index(md);
  if (!indexed) return null;
  const report = verifyTables(md);
  const tables = report.ok
    ? ''
    : ` Ojo: alguna tabla no cuadra (${describeIssues(report).replace(/\n/g, ' ')}); dile en una frase que la revise con el original.`;
  return `[Documento reenviado: "${label}", PDF escaneado: lo he leído con el OCR local e indexado${indexed.truncated ? ' PARCIALMENTE' : ''} en la memoria documental (${indexed.chars} caracteres). El OCR puede equivocarse con cifras y nombres.${tables} Úsalo con la herramienta documents para contestar.]`;
}

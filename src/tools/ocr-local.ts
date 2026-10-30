/**
 * OCR local opcional (PP-OCRv5 o GLM-OCR) en un sidecar de Python, apagado por
 * defecto (src/plugins/ocr.ts). Sin APIs de pago ni claves del modelo. Distinta de la tool `ocr`
 * (pantalla con el OCR de Windows): esta lee una imagen/PDF de las carpetas permitidas.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export type OcrModel = 'ppocr' | 'glm';

export const OCR_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.pdf'];
export const OCR_MAX_INPUT_BYTES = 25 * 1024 * 1024;
/** Tope de lo que se acepta del sidecar por stdout: más que esto es un fallo, no texto. */
export const OCR_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** GLM-OCR tarda ~9 s por página en CPU; un PDF de 20 páginas cabe holgado. */
export const OCR_TIMEOUT_MS = 300_000;

function inside(child: string, root: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(norm(root), norm(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Siguiendo enlaces, la ruta debe caer dentro de una carpeta permitida (`../` y symlinks fuera, no). */
export async function resolveOcrPath(raw: string, roots: string[]): Promise<string> {
  const p = resolve(raw.trim());
  const ext = extname(p).toLowerCase();
  if (!OCR_EXTENSIONS.includes(ext)) {
    throw new Error(`Solo leo imágenes o PDF (${OCR_EXTENSIONS.join(', ')}): ${raw}`);
  }
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    throw new Error(`No encuentro el fichero: ${raw}`);
  }
  const realRoots: string[] = [];
  for (const r of roots) {
    try {
      realRoots.push(await realpath(r));
    } catch {
      // una carpeta configurada que no existe no permite nada
    }
  }
  if (!realRoots.some((r) => inside(real, r))) {
    throw new Error(`Ese fichero está fuera de las carpetas permitidas para el OCR: ${raw}`);
  }
  const s = await stat(real);
  if (!s.isFile()) throw new Error(`No es un fichero: ${raw}`);
  if (s.size > OCR_MAX_INPUT_BYTES) {
    throw new Error(`El fichero pasa de ${OCR_MAX_INPUT_BYTES / 1024 / 1024} MB: ${raw}`);
  }
  return real;
}

export interface SidecarResult {
  text: string;
  pages: number;
}

export interface SidecarOptions {
  python: string;
  script: string;
  model: OcrModel;
  file: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnFn?: (cmd: string, args: string[]) => ChildProcess;
}

const installHint = (model: OcrModel) =>
  `El OCR local (${model === 'glm' ? 'GLM-OCR' : 'PP-OCRv5'}) no está instalado. En la carpeta de Asistenta: ` +
  `scripts\\ocr-sidecar\\setup.ps1 -Model ${model} (Windows) o scripts/ocr-sidecar/setup.sh ${model} (Linux). ` +
  'Ver «OCR local (opcional)» en el README.';

/** Lanza el sidecar una vez, con tiempo máximo y tope de salida, y lee su JSON. */
export function runOcrSidecar(o: SidecarOptions): Promise<SidecarResult> {
  const timeoutMs = o.timeoutMs ?? OCR_TIMEOUT_MS;
  const cap = o.maxOutputBytes ?? OCR_MAX_OUTPUT_BYTES;
  const args = [o.script, '--model', o.model, '--input', o.file];
  const spawnFn =
    o.spawnFn ??
    ((cmd: string, a: string[]) =>
      spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }));
  return new Promise((done, fail) => {
    let child: ChildProcess;
    try {
      child = spawnFn(o.python, args);
    } catch {
      fail(new Error(installHint(o.model)));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (err: Error | null, value?: SidecarResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill('SIGKILL');
        fail(err);
      } else done(value as SidecarResult);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(`El OCR local tardó más de ${Math.round(timeoutMs / 1000)} s y lo he parado.`),
        ),
      timeoutMs,
    );
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length;
      if (size > cap) {
        finish(new Error('El OCR local devolvió demasiada salida y lo he parado.'));
        return;
      }
      chunks.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < 2000) stderr += b.toString('utf8');
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(
        e.code === 'ENOENT'
          ? new Error(installHint(o.model))
          : new Error(`El OCR local no arrancó: ${e.message}`),
      ),
    );
    child.on('close', (code) => {
      if (settled) return;
      const out = Buffer.concat(chunks).toString('utf8').trim();
      let parsed: {
        ok?: unknown;
        text?: unknown;
        pages?: unknown;
        error?: unknown;
        detail?: unknown;
      };
      try {
        parsed = JSON.parse(out.split('\n').pop() ?? '');
      } catch {
        const why = stderr.trim().split('\n').pop()?.slice(0, 300) || `código ${code}`;
        finish(new Error(`El OCR local falló: ${why}`));
        return;
      }
      if (parsed.ok === true && typeof parsed.text === 'string') {
        finish(null, {
          text: parsed.text,
          pages: typeof parsed.pages === 'number' ? parsed.pages : 1,
        });
      } else if (parsed.error === 'missing_engine') {
        finish(new Error(installHint(o.model)));
      } else {
        finish(
          new Error(
            `El OCR local falló: ${String(parsed.detail ?? parsed.error ?? 'sin detalle').slice(0, 300)}`,
          ),
        );
      }
    });
  });
}

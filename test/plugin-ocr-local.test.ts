import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/core/capabilities.js';
import {
  createOcrLocalTool,
  OCR_LOCAL_DISABLED,
  OCR_MAX_TEXT_CHARS,
  ocrLocalPlugin,
  ocrModelFromEnv,
  ocrPython,
  ocrRoots,
} from '../src/plugins/ocr.js';

describe('OCR local como plugin opcional', () => {
  it('apagado por defecto: sin PA_OCR_LOCAL=1 no aporta ninguna tool', () => {
    expect(ocrLocalPlugin.tools({ env: {} })).toEqual([]);
    expect(ocrLocalPlugin.tools({ env: { PA_OCR_LOCAL: '0' } })).toEqual([]);
    expect(ocrLocalPlugin.tools({ env: { PA_OCR_LOCAL: '1' } }).map((t) => t.name)).toEqual([
      'ocr_local',
    ]);
  });

  it('Python del venv del sidecar según el sistema, o PA_OCR_PYTHON', () => {
    expect(ocrPython({}, 'win32')).toMatch(/ocr-sidecar[\\/]\.venv[\\/]Scripts[\\/]python\.exe$/);
    expect(ocrPython({}, 'linux')).toMatch(/ocr-sidecar[\\/]\.venv[\\/]bin[\\/]python$/);
    expect(ocrPython({ PA_OCR_PYTHON: 'C:\\py\\python.exe' }, 'win32')).toBe('C:\\py\\python.exe');
    expect(ocrRoots({ PA_OCR_WATCH_DIR: '/scan' })).toEqual([process.cwd(), '/scan']);
  });

  it('el catálogo de capacidades conoce ocr_local y cli.ts solo lo registra', () => {
    expect(CAPABILITIES.some((c) => c.name === 'ocr_local')).toBe(true);
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(/ocrLocalPlugin\.tools\(\{\}\)/);
    expect(cli).not.toMatch(/runOcrSidecar\(/);
  });
});

describe('PA_OCR_MODEL', () => {
  it('PA_OCR_MODEL: ppocr por defecto, glm opcional, lo demás no vale', () => {
    expect(ocrModelFromEnv({})).toBe('ppocr');
    expect(ocrModelFromEnv({ PA_OCR_MODEL: ' GLM ' })).toBe('glm');
    expect(ocrModelFromEnv({ PA_OCR_MODEL: 'tesseract' })).toBeNull();
  });
});

describe('la tool ocr_local', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-ocr-tool-'));
  const img = join(root, 'a.png');
  writeFileSync(img, 'x');
  const mk = (env: NodeJS.ProcessEnv, textOut = 'hola') => {
    const seen: string[] = [];
    const tool = createOcrLocalTool({
      env,
      roots: () => [root],
      run: async (model, file) => {
        seen.push(`${model}:${file}`);
        return { text: textOut, pages: 1 };
      },
    });
    return { tool, seen };
  };
  const out = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it('apagada: responde el aviso en castellano sin lanzar nada', async () => {
    const { tool, seen } = mk({});
    expect(out(await tool.execute('1', { path: img }))).toBe(OCR_LOCAL_DISABLED);
    expect(seen).toEqual([]);
  });

  it('encendida: devuelve el texto con el modelo elegido y recorta avisando', async () => {
    const { tool, seen } = mk({ PA_OCR_LOCAL: '1', PA_OCR_MODEL: 'glm' });
    expect(out(await tool.execute('1', { path: img }))).toBe('hola');
    expect(seen[0]).toMatch(/^glm:.*a\.png$/);
    const big = mk({ PA_OCR_LOCAL: '1' }, 'a'.repeat(OCR_MAX_TEXT_CHARS + 5));
    expect(out(await big.tool.execute('1', { path: img }))).toMatch(/\[recortado: 20000 de 20005/);
  });

  it('un PA_OCR_MODEL desconocido se dice, no se adivina', async () => {
    const { tool, seen } = mk({ PA_OCR_LOCAL: '1', PA_OCR_MODEL: 'nube' });
    expect(out(await tool.execute('1', { path: img }))).toMatch(/usa ppocr o glm/);
    expect(seen).toEqual([]);
  });
});

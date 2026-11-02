import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Playwright, teleproto y pdf-lib suman ~400 ms al arrancar `pa` (cualquier orden y el
// demonio) aunque no se usen: se cargan al abrir el navegador, el userbot o un PDF.
const cargados = vi.hoisted(() => [] as string[]);
vi.mock('playwright', () => {
  cargados.push('playwright');
  return { chromium: {} };
});
vi.mock('teleproto', () => {
  cargados.push('teleproto');
  return { Api: {}, TelegramClient: class {} };
});
vi.mock('teleproto/sessions/index.js', () => {
  cargados.push('teleproto/sessions');
  return { StringSession: class {} };
});
vi.mock('pdf-lib', () => {
  cargados.push('pdf-lib');
  return { PDFDocument: {}, StandardFonts: {} };
});

const PESADOS = ['playwright', 'teleproto', 'pdf-lib'];

function ficheros(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? ficheros(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

describe('carga perezosa de módulos pesados', () => {
  it('importar navegador, renfe, userbot y OCR de documentos no carga playwright, teleproto ni pdf-lib', async () => {
    await import('../src/browser/service.js');
    await import('../src/tools/renfe.js');
    await import('../src/books/userbot.js');
    await import('../src/ocrdoc/engine.js');
    expect(cargados).toEqual([]);
  });

  it('ningún fichero de src importa playwright, teleproto o pdf-lib con import de valor arriba del todo', () => {
    const malos: string[] = [];
    for (const f of ficheros(join(process.cwd(), 'src'))) {
      for (const linea of readFileSync(f, 'utf8').split('\n')) {
        const m = /^import\s+(?!type\b)[^'"]*from\s+['"]([^'"]+)['"]/.exec(linea);
        const mod = m?.[1];
        if (mod && PESADOS.some((p) => mod === p || mod.startsWith(`${p}/`)))
          malos.push(`${f}: ${linea}`);
      }
    }
    expect(malos).toEqual([]);
  });
});

// obsidian-1: con la memoria en Obsidian se ve lo que desaparece. Pasado el tope de
// 64 KB por chat, los hechos más antiguos salían de la memoria y se perdían; ahora
// van enteros a notas/archivo/<tema>.md (o archivo/<chat>.md), fuera del contexto.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_MEMORY_BYTES, MemoryStore, scopeToFilename } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const DM = 'telegram:dm:42#main';
const notas = (): string => {
  const dir = join(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'obsidian1-arch-')), 'notas');
  mkdirSync(dir, { recursive: true });
  return dir;
};
const largo = (n: number): string => `Hecho número ${n} ${'x'.repeat(1900)}`;

describe('lo que no cabe en la memoria va al archivo, no se pierde', () => {
  it('memoria por temas: el más antiguo sale del contexto y queda en notas/archivo/<tema>.md', () => {
    const dir = notas();
    const m = new MemoryStore(dir, { porTema: true, obsidian: true, ambitoSinChat: DM });
    const primero = m.remember(DM, largo(0), { tema: 'trabajo' });
    const n = Math.ceil(MAX_MEMORY_BYTES / 1900) + 2;
    for (let i = 1; i <= n; i++) m.remember(DM, largo(i), { tema: 'trabajo' });
    expect(m.get(DM, primero.id)).toBeNull();
    const archivo = join(dir, 'archivo', 'trabajo.md');
    expect(existsSync(archivo)).toBe(true);
    const t = readFileSync(archivo, 'utf8');
    expect(t).toContain('# Archivo: trabajo');
    expect(t).toContain('  - memoria/archivo');
    expect(t).toContain(`[${primero.id}]`);
    expect(t).toContain(largo(0));
    // Nunca dos veces el mismo hecho, y el archivo no cuenta como tema.
    expect(t.split(`[${primero.id}]`).length).toBe(2);
    expect(m.temas().map((x) => x.tema)).toEqual(['trabajo']);
  });

  it('recall sin resultados busca en el archivo, y nunca hechos de otro chat', async () => {
    const dir = notas();
    const m = new MemoryStore(dir, { porTema: true, ambitoSinChat: DM });
    m.remember(DM, `La llave de repuesto está en la nevera ${'x'.repeat(1900)}`, { tema: 'casa' });
    m.remember('telegram:dm:7#main', 'El wifi del vecino es otro', { tema: 'casa' });
    const n = Math.ceil(MAX_MEMORY_BYTES / 1900) + 2;
    for (let i = 1; i <= n; i++) m.remember(DM, largo(i), { tema: 'casa' });
    const call = async (scope: string, query: string): Promise<string> =>
      (
        await createMemoryTool(m, () => scope).execute(
          't',
          { action: 'recall', query } as never,
          undefined as never,
          undefined as never,
        )
      ).content
        .map((c) => (c as { text?: string }).text ?? '')
        .join('\n');
    const r = await call(DM, 'nevera');
    expect(r).toContain('en el archivo');
    expect(r).toContain('está en la nevera');
    expect(m.buscarArchivo(['telegram:dm:7#main'], 'nevera')).toEqual([]);
  });

  it('memoria por chat: lo mismo, en archivo/<chat>.md', () => {
    const dir = notas();
    const m = new MemoryStore(dir);
    const primero = m.remember(DM, largo(0));
    const n = Math.ceil(MAX_MEMORY_BYTES / 1900) + 2;
    for (let i = 1; i <= n; i++) m.remember(DM, largo(i));
    expect(m.get(DM, primero.id)).toBeNull();
    const t = readFileSync(join(dir, 'archivo', scopeToFilename(DM)), 'utf8');
    expect(t).toContain(`[${primero.id}]`);
    expect(t).toContain(largo(0));
    expect(m.scopes()).toEqual([DM]);
  });
});

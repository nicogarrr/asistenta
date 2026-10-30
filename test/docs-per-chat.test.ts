import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocMemory } from '../src/memory/docs.js';
import { memoryScopesFor } from '../src/memory.js';
import { createDocsTool } from '../src/tools/docs.js';

// Como la memoria (#473): un documento que llega en un hilo (respuesta, /topic)
// quedaba en ese hilo y desde el chat principal «no lo encontraba».
const textOf = (r: unknown): string =>
  (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n');
const mem = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-docs-chat-'));
  return new DocMemory({
    dbPath: join(dir, 'd.sqlite'),
    directory: join(dir, 'm'),
    now: () => 1_800_000_000_000,
  });
};
const run = (m: DocMemory, scope: string, args: Record<string, unknown>) =>
  createDocsTool(m, () => scope).execute(
    't',
    args as never,
    undefined as never,
    undefined as never,
  );

describe('documentos por chat, no por hilo', () => {
  it('el chat comparte documentos con sus hilos (se indexan en <chat>#main), nunca con otro chat', async () => {
    const m = mem();
    // cli.ts indexa en memoryScopesFor(thread.key).write = <chat>#main
    await m.index(
      memoryScopesFor('telegram:bot:42#r9').write,
      { fileId: 'f1', name: 'contrato-alquiler.txt', mimeType: 'text/plain' },
      Buffer.from('la fianza del alquiler es de dos mensualidades'),
    );
    expect(
      textOf(await run(m, 'telegram:bot:42#main', { action: 'search', query: 'fianza' })),
    ).toContain('contrato-alquiler');
    expect(textOf(await run(m, 'telegram:bot:42#main', { action: 'list' }))).toContain(
      'contrato-alquiler',
    );
    expect(
      textOf(await run(m, 'telegram:bot:99#main', { action: 'search', query: 'fianza' })),
    ).not.toContain('contrato-alquiler');
  });
});

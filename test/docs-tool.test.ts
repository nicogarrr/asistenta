import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocMemory } from '../src/memory/docs.js';
import { createDocsTool } from '../src/tools/docs.js';

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.map((c) => c.text ?? '').join('\n');
}

/** The runtime scope convention: the thread key (chatKey#name) is the memory
 * scope everywhere - indexing and reading. This test walks both paths with
 * thread-key-shaped scopes, the way cli.ts wires them. */
const THREAD_A = 'telegram:main:111#main';
const THREAD_B = 'telegram:main:222#main';

describe('documents tool', () => {
  let dir: string;
  let mem: DocMemory;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'doctool-'));
    mem = new DocMemory({
      dbPath: join(dir, 'd.sqlite'),
      directory: join(dir, 'm'),
      now: () => 1_800_000_000_000,
    });
    await mem.index(
      THREAD_A,
      { fileId: 'x1', name: 'nomina-marzo.pdf', mimeType: 'text/plain' },
      Buffer.from('la nomina de marzo incluye el bonus trimestral'),
    );
    await mem.index(
      THREAD_B,
      { fileId: 'x2', name: 'ajeno.txt', mimeType: 'text/plain' },
      Buffer.from('bonus confidencial de otro chat'),
    );
  });
  afterAll(() => {
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds through the tool what was indexed under the same thread key', async () => {
    const tool = createDocsTool(mem, () => THREAD_A);
    const res = await tool.execute('t1', { action: 'search', query: 'bonus' });
    expect(textOf(res)).toContain('nomina-marzo.pdf');
    expect(textOf(res)).not.toContain('ajeno');
  });

  it('keeps the other thread invisible', async () => {
    const tool = createDocsTool(mem, () => THREAD_B);
    const res = await tool.execute('t2', { action: 'search', query: 'bonus' });
    expect(textOf(res)).toContain('ajeno.txt');
    expect(textOf(res)).not.toContain('nomina');
  });

  it('says "not found", never "does not exist"', async () => {
    const tool = createDocsTool(mem, () => THREAD_A);
    const res = await tool.execute('t3', { action: 'search', query: 'inexistente' });
    expect(textOf(res)).toMatch(/No he encontrado/);
    expect(textOf(res)).not.toMatch(/no está en la memoria|no existe/i);
  });

  it('refuses a search without query', async () => {
    const tool = createDocsTool(mem, () => THREAD_A);
    await expect(tool.execute('t4', { action: 'search' })).rejects.toThrow(/query/);
  });

  it('lists the shelf of the caller thread, marking partial indexes', async () => {
    await mem.index(
      THREAD_B,
      { fileId: 'big', name: 'largo.txt', mimeType: 'text/plain' },
      Buffer.from('z'.repeat(610_009)),
    );
    const tool = createDocsTool(mem, () => THREAD_B);
    const res = await tool.execute('t5', { action: 'list' });
    expect(textOf(res)).toContain('ajeno.txt');
    expect(textOf(res)).toContain('indexado parcial');
    expect(textOf(res)).not.toContain('nomina');
  });
});

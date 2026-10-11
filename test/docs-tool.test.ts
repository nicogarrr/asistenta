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
      'chat-a',
      { fileId: 'x1', name: 'nomina-marzo.pdf', mimeType: 'text/plain' },
      Buffer.from('la nomina de marzo incluye el bonus trimestral'),
    );
    await mem.index(
      'chat-b',
      { fileId: 'x2', name: 'ajeno.txt', mimeType: 'text/plain' },
      Buffer.from('bonus confidencial de otro chat'),
    );
  });
  afterAll(() => {
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('searches within the caller scope only', async () => {
    const tool = createDocsTool(mem, () => 'chat-a');
    const res = await tool.execute('t1', { action: 'search', query: 'bonus' });
    expect(textOf(res)).toContain('nomina-marzo.pdf');
    expect(textOf(res)).not.toContain('ajeno');
  });

  it('says so plainly when nothing matches', async () => {
    const tool = createDocsTool(mem, () => 'chat-a');
    const res = await tool.execute('t2', { action: 'search', query: 'inexistente' });
    expect(textOf(res)).toMatch(/Nada en la memoria documental/);
  });

  it('refuses a search without query', async () => {
    const tool = createDocsTool(mem, () => 'chat-a');
    await expect(tool.execute('t3', { action: 'search' })).rejects.toThrow(/query/);
  });

  it('lists the shelf of the caller chat', async () => {
    const tool = createDocsTool(mem, () => 'chat-b');
    const res = await tool.execute('t4', { action: 'list' });
    expect(textOf(res)).toContain('ajeno.txt');
    expect(textOf(res)).not.toContain('nomina');
  });
});

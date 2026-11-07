// asis-memoria-8: la herramienta memory también ACTUALIZA un hecho (no solo
// guarda y olvida): el nuevo sustituye al viejo y el viejo queda como historia.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'upd:test#main';
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n');

describe('memory action=update', () => {
  it('sustituye el hecho, en disco al momento, y el viejo queda como historia', async () => {
    const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'upd-'));
    const memory = new MemoryStore(join(dir, 'notas'));
    const tool = createMemoryTool(memory, () => SCOPE);
    const a = await tool.execute('c1', { action: 'remember', text: 'Nico pesa 80 kg' });
    const oldId = (a.details as { id: string }).id;
    const u = await tool.execute('c2', { action: 'update', id: oldId, text: 'Nico pesa 78 kg' });
    expect(textOf(u)).toContain('Actualizado');
    expect(u.details).toMatchObject({ updated: true, replaces: oldId });
    const disco = readFileSync(memory.fileFor(SCOPE), 'utf8');
    expect(disco).toContain('78 kg');
    expect(disco).toContain('80 kg');
    const list = await tool.execute('c3', { action: 'list' });
    expect(textOf(list)).toContain('78 kg');
    expect(textOf(list)).not.toContain('80 kg');
  });

  it('id desconocido o clave: no escribe nada', async () => {
    const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'upd-'));
    const memory = new MemoryStore(join(dir, 'notas'));
    const tool = createMemoryTool(memory, () => SCOPE);
    const r = await tool.execute('c4', { action: 'update', id: 'noexiste', text: 'x' });
    expect(r.details).toMatchObject({ updated: false });
    const a = await tool.execute('c5', { action: 'remember', text: 'mi banco es el BBVA' });
    const id = (a.details as { id: string }).id;
    const s = await tool.execute('c6', {
      action: 'update',
      id,
      text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    });
    expect(textOf(s)).not.toContain('Actualizado');
    expect(readFileSync(memory.fileFor(SCOPE), 'utf8')).not.toContain('ghp_');
  });
});

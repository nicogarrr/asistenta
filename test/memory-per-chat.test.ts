import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMemoryCommand } from '../src/cli.js';
import { MemoryStore, memoryScopesFor } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

const store = () => new MemoryStore(mkdtempSync(join(tmpdir(), 'pa-mem-chat-')));
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('\n');
const call = (s: MemoryStore, scope: string, args: Record<string, unknown>) =>
  createMemoryTool(s, () => scope).execute(
    't',
    args as never,
    undefined as never,
    undefined as never,
  );

describe('memoria por chat, no por hilo', () => {
  it('memoryScopesFor: escribe en <chat>#main y lee hilo + main, sin tocar otros ámbitos', () => {
    expect(memoryScopesFor('telegram:bot:42#r17')).toEqual({
      write: 'telegram:bot:42#main',
      read: ['telegram:bot:42#main', 'telegram:bot:42#r17'],
    });
    expect(memoryScopesFor('telegram:bot:42#main')).toEqual({
      write: 'telegram:bot:42#main',
      read: ['telegram:bot:42#main'],
    });
    expect(memoryScopesFor('local')).toEqual({ write: 'local', read: ['local'] });
  });

  it('un hecho dicho respondiendo a un mensaje se recuerda luego en el chat principal', async () => {
    const s = store();
    await call(s, 'telegram:bot:42#r17', {
      action: 'remember',
      text: 'mi dentista es la doctora Ruiz',
    });
    const out = text(
      await call(s, 'telegram:bot:42#main', { action: 'recall', query: 'dentista' }),
    );
    expect(out).toContain('doctora Ruiz');
    expect(runMemoryCommand(s, 'telegram:bot:42#main')).toContain('doctora Ruiz');
  });

  it('nunca cruza chats', async () => {
    const s = store();
    await call(s, 'telegram:bot:42#r17', {
      action: 'remember',
      text: 'mi dentista es la doctora Ruiz',
    });
    const other = text(
      await call(s, 'telegram:bot:99#main', { action: 'recall', query: 'dentista' }),
    );
    expect(other).not.toContain('Ruiz');
    expect(runMemoryCommand(s, 'telegram:bot:99#main')).not.toContain('Ruiz');
  });

  it('los hechos viejos guardados bajo un hilo siguen visibles desde ese hilo y se pueden olvidar', async () => {
    const s = store();
    const old = s.remember('telegram:bot:42#viaje', 'el vuelo sale el 3 de noviembre');
    expect(
      text(await call(s, 'telegram:bot:42#viaje', { action: 'recall', query: 'vuelo' })),
    ).toContain('3 de noviembre');
    await call(s, 'telegram:bot:42#viaje', { action: 'forget', id: old.id });
    expect(s.all('telegram:bot:42#viaje').filter((e) => e.supersededBy === null)).toEqual([]);
  });
});

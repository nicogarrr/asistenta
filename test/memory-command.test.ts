import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMemoryCommand } from '../src/cli.js';
import { MemoryStore } from '../src/memory.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-memory-cmd-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('runMemoryCommand', () => {
  it('lee el scope thread.key, no el chatKey pelado (auditoría: /memory casi siempre decía que no recordaba nada)', () => {
    const store = new MemoryStore(dir);
    // Así guarda todo lo demás (contexto del turno, tool memory): chatKey#thread.
    store.remember('telegram:123#main', 'prefiere respuestas cortas');
    const reply = runMemoryCommand(store, 'telegram:123#main');
    expect(reply).toContain('Recuerdo 1 cosas:');
    expect(reply).toContain('prefiere respuestas cortas');
    // El scope viejo del comando: con la memoria llena decía no recordar nada.
    expect(runMemoryCommand(store, 'telegram:123')).toContain('No recuerdo nada');
  });

  it('sin memoria lo dice y cuenta las conversaciones con memoria', () => {
    const store = new MemoryStore(dir);
    expect(runMemoryCommand(store, 'telegram:123#main')).toContain('(0 conversaciones con memoria)');
    store.remember('telegram:999#main', 'un dato de otro chat');
    expect(runMemoryCommand(store, 'telegram:123#main')).toContain('(1 conversaciones con memoria)');
  });
});

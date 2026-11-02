import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMemoryCommand } from '../src/cli.js';
import { aboutMeText } from '../src/memory/owner-facts.js';
import { MemoryStore } from '../src/memory.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs19-memoria-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// asis-bugs-19: /memory decía «Recuerdo 1 cosas:» y «(1 conversaciones con memoria)», y
// «¿qué sabes de mí?» «(y 1 cosas más antiguas)».
describe('memoria: con una sola cosa, en singular', () => {
  it('/memory con un recuerdo', () => {
    const store = new MemoryStore(dir);
    store.remember('telegram:123#main', 'prefiere respuestas cortas');
    const reply = runMemoryCommand(store, 'telegram:123#main');
    expect(reply).toContain('Recuerdo 1 cosa:');
    expect(reply).not.toContain('1 cosas');
    store.remember('telegram:123#main', 'vive en Madrid');
    expect(runMemoryCommand(store, 'telegram:123#main')).toContain('Recuerdo 2 cosas:');
  });

  it('/memory vacío con una sola conversación con memoria', () => {
    const store = new MemoryStore(dir);
    store.remember('telegram:999#main', 'un dato de otro chat');
    const reply = runMemoryCommand(store, 'telegram:123#main');
    expect(reply).toContain('(1 conversación con memoria)');
    store.remember('telegram:888#main', 'otro dato');
    expect(runMemoryCommand(store, 'telegram:123#main')).toContain(
      '(2 conversaciones con memoria)',
    );
  });

  it('«¿qué sabes de mí?» con una sola cosa más antigua sin mostrar', () => {
    const text = aboutMeText(['uno', 'dos', 'tres'], 2);
    expect(text).toContain('(y 1 cosa más antigua)');
    expect(aboutMeText(['uno', 'dos', 'tres', 'cuatro'], 2)).toContain('(y 2 cosas más antiguas)');
  });
});

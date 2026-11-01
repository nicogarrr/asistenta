import { describe, expect, it } from 'vitest';
import * as cli from '../src/cli.js';
import * as note from '../src/daemon/context-note.js';

// P2 (ARCHITECTURE.md): the per-turn context note (memory, history, routines,
// workstreams, skills, now, project) lives in src/daemon/context-note.ts; cli.ts
// re-exports the very same bindings, so every existing import keeps working.
describe('context-note module', () => {
  it('cli.ts re-exports the same bindings (pure move)', () => {
    expect(typeof note.buildContextNote).toBe('function');
    expect(cli.buildContextNote).toBe(note.buildContextNote);
    expect(typeof note.ANTICIPATION_RULES).toBe('string');
    expect(cli.ANTICIPATION_RULES).toBe(note.ANTICIPATION_RULES);
  });

  it('keeps the anticipation rules fenced', () => {
    expect(note.ANTICIPATION_RULES.startsWith('<anticipation>')).toBe(true);
    expect(note.ANTICIPATION_RULES.endsWith('</anticipation>')).toBe(true);
  });
});

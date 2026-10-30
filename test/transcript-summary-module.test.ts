import { describe, expect, it } from 'vitest';
import * as cli from '../src/cli.js';
import * as summary from '../src/daemon/transcript-summary.js';

// P2 (ARCHITECTURE.md): summarizeTranscript lives in src/daemon/transcript-summary.ts;
// cli.ts re-exports the very same function, so every existing import keeps working.
describe('transcript-summary module', () => {
  it('cli.ts re-exports the same function (pure move)', () => {
    expect(typeof summary.summarizeTranscript).toBe('function');
    expect(cli.summarizeTranscript).toBe(summary.summarizeTranscript);
  });

  it('behaves as before: words and tool names, never tool arguments', () => {
    const out = summary.summarizeTranscript([
      { role: 'user', content: 'haz la compra' },
      { role: 'assistant', content: [{ type: 'text', text: 'voy' }, { type: 'image' }] },
      { role: 'toolResult', toolName: 'browser', content: 'secreto123' },
      null,
    ]);
    expect(out).toBe('usuario: haz la compra\nagente: voy\nherramienta: browser');
    expect(summary.summarizeTranscript([])).toBe('(no hubo actividad)');
  });
});

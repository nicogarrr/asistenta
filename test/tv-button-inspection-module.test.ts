import { describe, expect, it } from 'vitest';
import * as cli from '../src/cli.js';
import * as insp from '../src/daemon/inspection-thread.js';
import * as tv from '../src/daemon/tv-button.js';

// P2 (ARCHITECTURE.md): tvButtonAction and inspectionThreadKey live in src/daemon;
// cli.ts re-exports the very same functions, so every existing import keeps working.
describe('tv-button / inspection-thread modules', () => {
  it('cli.ts re-exports the same functions (pure move)', () => {
    expect(typeof tv.tvButtonAction).toBe('function');
    expect(cli.tvButtonAction).toBe(tv.tvButtonAction);
    expect(typeof insp.inspectionThreadKey).toBe('function');
    expect(cli.inspectionThreadKey).toBe(insp.inspectionThreadKey);
  });

  it('tvButtonAction behaves as before', () => {
    expect(tv.tvButtonAction({ hasChat: false, hasListener: true, sessionOpen: true })).toBe(
      'no-chat',
    );
    expect(tv.tvButtonAction({ hasChat: true, hasListener: false, sessionOpen: true })).toBe(
      'already-open',
    );
    expect(tv.tvButtonAction({ hasChat: true, hasListener: false, sessionOpen: false })).toBe(
      'need-mic',
    );
    expect(tv.tvButtonAction({ hasChat: true, hasListener: true, sessionOpen: false })).toBe(
      'open-session',
    );
  });

  it('inspectionThreadKey behaves as before', () => {
    expect(insp.inspectionThreadKey({ chatKey: 'tg:1', activeTopic: 'x', threadId: '9' })).toBe(
      'tg:1#x',
    );
    expect(insp.inspectionThreadKey({ chatKey: 'tg:1', replyThreadKey: 'tg:1#r' })).toBe('tg:1#r');
    expect(insp.inspectionThreadKey({ chatKey: 'tg:1', threadId: '9' })).toBe('tg:1#t9');
    expect(insp.inspectionThreadKey({ chatKey: 'tg:1' })).toBe('tg:1#main');
  });
});

/**
 * The prompt promises that playing audio the user already sent (and listing
 * what is stored) "needs no permission", but until P2-14 every media call
 * fell into ask-unlisted and raised buttons. These canaries go through
 * `createDaemonGate` - the wiring the daemon actually uses - so the promise
 * and the gate cannot drift apart again without a red test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalChoice } from '../src/channels/telegram.js';
import { approvalsDbPath, createDaemonGate } from '../src/cli.js';

const MAIN = 'telegram:main:42#main';

let dir = '';
let asked = 0;

const channel = (): Promise<ApprovalChoice> => {
  asked += 1;
  return Promise.resolve({ approved: true, scope: 'once' });
};

const media = (action: string) => ({ tool: 'media', args: { action }, actor: 'asistenta' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-media-free-'));
  asked = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('media allowActions (P2-14)', () => {
  it.each(['play', 'list_audio'])('media:%s passes without asking, as the prompt promises', async (action) => {
    const gate = createDaemonGate({ threadKey: MAIN, dbPath: approvalsDbPath(dir), ask: channel });
    const d = await gate.check(MAIN, media(action));
    expect(d.verdict).toBe('allow');
    expect(asked).toBe(0);
  });

  it.each(['camera_photo', 'camera_clip', 'camera_audio_clip', 'mic_record', 'screen_clip', 'live_view'])(
    'media:%s still asks every time',
    async (action) => {
      const gate = createDaemonGate({ threadKey: MAIN, dbPath: approvalsDbPath(dir), ask: channel });
      const d = await gate.check(MAIN, media(action));
      expect(d.verdict).toBe('allow'); // the channel said yes...
      expect(asked).toBe(1); // ...but it was ASKED
    },
  );
});

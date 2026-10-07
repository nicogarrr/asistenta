import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AudioRecall } from '../src/media/recall.js';
import { playbackRestoreText } from '../src/tools/system.js';

it('inactive chat expires at deadline without reading that chat and corrupt-index orphan is removed', () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'audio-expire-'));
  try {
    const r = new AudioRecall({ directory: dir, ttlMs: 1000 });
    r.record('A', { fileId: 'f', messageId: 'm', mimeType: 'audio/ogg' });
    r.retain('A', 'm', Buffer.from('original'));
    vi.advanceTimersByTime(1001);
    r.record('B', { fileId: 'b', messageId: 'b', mimeType: 'audio/ogg' });
    expect(readdirSync(dir).filter((n) => n.endsWith('.audio'))).toHaveLength(0);
    writeFileSync(join(dir, 'orphan.audio'), 'orphan');
    writeFileSync(join(dir, 'index.json'), '{broken');
    new AudioRecall({ directory: dir, ttlMs: 1000 });
    expect(readdirSync(dir).filter((n) => n.endsWith('.audio'))).toHaveLength(0);
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('restore failures are distinct from deliberate leave-volume and warn in both playback paths', () => {
  expect(readFileSync('src/tools/system.ts', 'utf8')).toContain('restoreStatus');
  for (const f of ['src/cli.ts', 'src/tools/media.ts'])
    expect(readFileSync(f, 'utf8')).toContain('playbackRestoreText(res)');
});

it('new audio remains anchored after every old entry expires', () => {
  let now = 0;
  const r = new AudioRecall({ now: () => now, ttlMs: 1000 });
  r.record('A', { fileId: 'old', messageId: 'old', mimeType: 'audio/ogg' });
  now = 1001;
  r.record('A', { fileId: 'new', messageId: 'new', mimeType: 'audio/ogg' });
  expect(r.last('A')?.fileId).toBe('new');
});

it('failed restore copy differs from unrequested restore and warns of remaining high volume', () => {
  expect(playbackRestoreText({ restoreStatus: 'failed', volumeRestoredTo: null })).toContain(
    'Puede seguir alto',
  );
  expect(playbackRestoreText({ restoreStatus: 'not-requested', volumeRestoredTo: null })).toContain(
    'No se solicitó',
  );
  expect(playbackRestoreText({ restoreStatus: 'restored', volumeRestoredTo: 35 })).toContain('35%');
});

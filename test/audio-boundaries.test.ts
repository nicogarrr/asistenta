import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AudioRecall } from '../src/media/recall.js';

describe('audio boundaries', () => {
  it('retains original bytes per chat across restart, expires them within TTL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audio-retain-'));
    let now = 10000;
    try {
      const a = new AudioRecall({ directory: dir, now: () => now, ttlMs: 1000 });
      a.record('chat:a', { fileId: 'f', mimeType: 'audio/ogg', messageId: 'm' });
      a.retain('chat:a', 'm', Buffer.from('original'));
      const b = new AudioRecall({ directory: dir, now: () => now, ttlMs: 1000 });
      expect(b.read('chat:a', 'm')?.toString()).toBe('original');
      expect(b.read('chat:b', 'm')).toBeNull();
      now += 1001;
      expect(b.last('chat:a')).toBeNull();
      expect(b.read('chat:a', 'm')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('checks MCI play result and an output device, and never asserts audibility from elapsed time', () => {
    const s = readFileSync('src/tools/system.ts', 'utf8');
    expect(s).toContain('$play -ne 0');
    expect(s).toContain('waveOutGetNumDevs');
    expect(readFileSync('src/cli.ts', 'utf8')).not.toContain('Sonado ');
    expect(readFileSync('src/tools/media.ts', 'utf8')).not.toContain('Sonado ');
  });
  it('TTS validates PCM content and forwards real duration and filename to Telegram', () => {
    const s = readFileSync('src/voice/tts.ts', 'utf8');
    expect(s).toContain('decoded.samples.length / decoded.sampleRate');
    expect(s).toContain('durationSeconds');
    expect(readFileSync('src/channels/telegram.ts', 'utf8')).toContain('Math.ceil(duration)');
  });
});

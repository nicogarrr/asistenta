import { describe, expect, it } from 'vitest';
import { isAudioDocument } from '../src/channels/telegram.js';

describe('isAudioDocument', () => {
  it('treats audio sent as a file like an audio message', () => {
    expect(isAudioDocument({ mime_type: 'audio/mpeg', file_name: 'nota.mp3' })).toBe(true);
    expect(isAudioDocument({ mime_type: 'audio/ogg' })).toBe(true);
    expect(isAudioDocument({ mime_type: 'application/ogg' })).toBe(true);
  });

  it('falls back to the extension only when the type is missing or generic', () => {
    expect(isAudioDocument({ file_name: 'PTT-2026.opus' })).toBe(true);
    expect(isAudioDocument({ mime_type: 'application/octet-stream', file_name: 'a.M4A' })).toBe(
      true,
    );
  });

  it('leaves real documents alone', () => {
    expect(isAudioDocument({ mime_type: 'application/pdf', file_name: 'a.pdf' })).toBe(false);
    expect(isAudioDocument({ mime_type: 'application/pdf', file_name: 'song.mp3' })).toBe(false);
    expect(isAudioDocument({ file_name: 'notas.txt' })).toBe(false);
    expect(isAudioDocument({})).toBe(false);
  });
});

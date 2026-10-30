import { describe, expect, it } from 'vitest';
import { isYoutubeHost } from '../src/media/download.js';
import { isFetchable } from '../src/tools/fetch.js';

// Un FQDN con punto final («localhost.») es el mismo host para DNS; la puerta léxica
// no debe dejarlo pasar donde el nombre sin punto se bloquea.
describe('isFetchable: nombres con punto final', () => {
  it.each([
    'http://localhost./',
    'http://LOCALHOST../x',
    'http://a.localhost./',
    'http://metadata./',
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://algo.internal./',
    'http://nas.local./',
  ])('bloquea %s', (u) => {
    expect(isFetchable(u)).toBe(false);
  });

  it('sigue permitiendo hosts públicos, con o sin punto final', () => {
    expect(isFetchable('https://example.com./')).toBe(true);
    expect(isFetchable('https://example.com/')).toBe(true);
    expect(isFetchable('https://localhost.example.com/')).toBe(true);
  });
});

describe('isYoutubeHost', () => {
  it('reconoce YouTube con mayúsculas o punto final', () => {
    expect(isYoutubeHost('youtube.com.')).toBe(true);
    expect(isYoutubeHost('WWW.YouTube.com.')).toBe(true);
    expect(isYoutubeHost('youtu.be')).toBe(true);
    expect(isYoutubeHost('m.youtube.com')).toBe(true);
  });
  it('no confunde otros hosts', () => {
    expect(isYoutubeHost('notyoutube.com')).toBe(false);
    expect(isYoutubeHost('youtube.com.evil.net')).toBe(false);
  });
});

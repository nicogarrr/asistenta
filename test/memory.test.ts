import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.js';
import {
  filenameToScope,
  looksLikeCredential,
  MAX_MEMORY_BYTES,
  type MemoryDoc,
  MemoryStore,
  parseMemory,
  scopeToFilename,
  serializeMemory,
} from '../src/memory.js';

// Stubbed so a test run cannot append to the real daily log under the state dir,
// and so the eviction and refusal warnings are assertable instead of noise.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-memory-'));
  store = new MemoryStore(dir);
  vi.mocked(log.warn).mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function warnings(): string[] {
  return vi.mocked(log.warn).mock.calls.map((call) => String(call[0]));
}

describe('scopeToFilename', () => {
  it('round-trips a normal chat key', () => {
    const scope = 'telegram:main:8258546109';
    const file = scopeToFilename(scope);
    expect(file).toBe('telegram%3Amain%3A8258546109.md');
    expect(filenameToScope(file)).toBe(scope);
  });

  it('round-trips a negative group id', () => {
    const scope = 'telegram:main:-1001234567890';
    expect(filenameToScope(scopeToFilename(scope))).toBe(scope);
  });

  it('round-trips hostile scopes without letting them escape the directory', () => {
    const hostile = [
      '../../etc/passwd',
      'C:\\Windows\\System32',
      '..',
      '.',
      'a/b\\c',
      'con',
      'COM1',
      'ñ 中文 🙂',
    ];
    for (const scope of hostile) {
      const file = scopeToFilename(scope);
      expect(file).not.toMatch(/[/\\]/);
      expect(file).not.toMatch(/^\./);
      expect(filenameToScope(file)).toBe(scope);
      expect(store.fileFor(scope)).toBe(join(dir, file));
    }
  });

  it('keeps scopes that only look alike distinct', () => {
    expect(scopeToFilename('a_b')).not.toBe(scopeToFilename('a:b'));
    expect(scopeToFilename('a b')).not.toBe(scopeToFilename('a%b'));
  });

  it('bounds an overlong scope and recovers it from the file header', () => {
    const scope = `telegram:main:${'9'.repeat(400)}`;
    const file = scopeToFilename(scope);
    expect(file.length).toBeLessThan(110);
    // Digest stems are not reversible from the name, which is exactly why every
    // file carries its scope in the header.
    expect(filenameToScope(file)).toBeNull();
    store.remember(scope, 'the wifi password is on the router sticker');
    expect(store.scopes()).toEqual([scope]);
    expect(readFileSync(join(dir, file), 'utf8')).toContain(`# Memory for ${scope}`);
  });

  it('produces a stable name for the same scope', () => {
    expect(scopeToFilename('telegram:main:1')).toBe(scopeToFilename('telegram:main:1'));
  });
});

describe('parse and serialize', () => {
  it('round-trips entries and free-form notes', () => {
    const doc: MemoryDoc = {
      scope: 'telegram:main:1',
      entries: [
        {
          id: 'm1',
          date: '2026-10-01',
          text: 'prefers Spanish',
          tags: [],
          supersedes: [],
          supersededBy: null,
        },
        {
          id: 'm2',
          date: '2026-10-02',
          text: 'prefers Catalan',
          tags: ['lang', 'work'],
          supersedes: ['m1'],
          supersededBy: null,
        },
        {
          id: 'm1',
          date: '2026-10-01',
          text: 'prefers Spanish',
          tags: [],
          supersedes: [],
          supersededBy: 'm2',
        },
      ],
      notes: ['## Notes', 'the flat above the bakery is where we park'],
    };
    expect(parseMemory(serializeMemory(doc))).toEqual(doc);
  });

  it('reads the documented format by hand', () => {
    const parsed = parseMemory(
      '# Memory for telegram:main:8258546109\n\n- [m3f2a1b4] (2026-10-01) user prefers answers in Spanish\n',
    );
    expect(parsed.scope).toBe('telegram:main:8258546109');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.id).toBe('m3f2a1b4');
    expect(parsed.entries[0]?.date).toBe('2026-10-01');
    expect(parsed.entries[0]?.text).toBe('user prefers answers in Spanish');
  });

  it('keeps unparseable lines instead of dropping them', () => {
    const parsed = parseMemory(
      '# Memory for s\n\n- not a bullet\n- [m1] (2026-10-01) fact\n\ntail note\n',
    );
    expect(parsed.entries.map((e) => e.text)).toEqual(['fact']);
    expect(parsed.notes).toEqual(['- not a bullet', 'tail note']);
  });

  it('survives a file the model rewrote with CRLF and no header', () => {
    const parsed = parseMemory('- [m1] (2026-10-01) fact\r\n\r\nnotes\r\n');
    expect(parsed.scope).toBe('');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.notes).toEqual(['notes']);
  });
});

describe('MemoryStore', () => {
  it('returns an empty skeleton for a scope with no file', () => {
    const text = store.read('telegram:main:1');
    expect(text).toContain('# Memory for telegram:main:1');
    expect(text).toContain('Nothing remembered yet');
    expect(store.all('telegram:main:1')).toEqual([]);
  });

  it('remembers, reads back and recalls', () => {
    const first = store.remember('telegram:main:1', 'user prefers answers in Spanish', {
      tags: ['lang'],
    });
    store.remember('telegram:main:1', 'user drinks coffee in the morning', { tags: ['coffee'] });
    store.remember('telegram:main:1', 'the flat is in Gracia');

    expect(store.all('telegram:main:1')).toHaveLength(3);
    expect(store.read('telegram:main:1')).toContain(
      `- [${first.id}] (${first.date}, tags: lang) user prefers answers in Spanish`,
    );
    expect(store.recall('telegram:main:1', 'morning')).toHaveLength(1);
    expect(store.recall('telegram:main:1', 'GRACIA')).toHaveLength(1);
    expect(store.recall('telegram:main:1', 'nothing relevant here')).toEqual([]);
  });

  it('caps how many entries recall returns', () => {
    for (let i = 0; i < 30; i++) store.remember('s', `shared word number ${i}`);
    expect(store.recall('s', 'shared', 5)).toHaveLength(5);
    expect(store.recall('s', 'shared', 1_000)).toHaveLength(30);
    expect(store.recall('s', 'shared', 1_000_000).length).toBeLessThanOrEqual(50);
  });

  it('forgets by id', () => {
    const entry = store.remember('s', 'the backup key is in the drawer');
    expect(store.forget('s', entry.id)).toBe(true);
    expect(store.forget('s', entry.id)).toBe(false);
    expect(store.all('s')).toEqual([]);
  });

  it('forgets by substring and reports what went', () => {
    store.remember('s', 'moved to Valencia in March');
    store.remember('s', 'still keeps the Valencia gym membership');
    store.remember('s', 'prefers black coffee');
    expect(store.forgetMatching('s', 'valencia')).toHaveLength(2);
    expect(store.all('s').map((e) => e.text)).toEqual(['prefers black coffee']);
    expect(store.forgetMatching('s', '')).toEqual([]);
  });

  it('replaces a wrong fact in place by id', () => {
    store.remember('s', 'works in Barcelona', { id: 'mjob' });
    const updated = store.remember('s', 'works in Girona', { id: 'mjob' });
    expect(store.all('s')).toHaveLength(1);
    expect(updated.text).toBe('works in Girona');
  });

  it('supersedes a fact and hides the old one from recall', () => {
    const old = store.remember('s', 'user is allergic to nuts');
    store.supersede('s', old.id, 'user avoids nuts but eats fish');
    const recalled = store.recall('s', 'nuts');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.text).toBe('user avoids nuts but eats fish');
    // Both survive on disk: a correction is new information, not an erasure.
    expect(store.all('s')).toHaveLength(2);
    expect(store.all('s').find((e) => e.id === old.id)?.supersededBy).toBeTruthy();
    expect(() => store.supersede('s', 'nope', 'x')).toThrow(/no memory with id/);
  });

  it('evicts the oldest entries once the file passes the cap', () => {
    for (let i = 0; i < 110; i++) store.remember('s', `fact ${i} ${'padding '.repeat(80)}`);
    const text = store.read('s');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    expect(warnings().some((msg) => msg.includes('evicted oldest entries'))).toBe(true);
    const entries = store.all('s');
    expect(entries.length).toBeLessThan(110);
    // Newest survive, oldest are gone: that is the whole point of a cap.
    expect(entries.at(-1)?.text).toContain('fact 109');
    expect(text).not.toContain('fact 0 ');
  });

  it('leaves no tmp file behind after writing', () => {
    for (let i = 0; i < 5; i++) store.remember('s', `fact ${i}`);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('re-reads the file, so a hand edit survives the next write', () => {
    store.remember('s', 'first fact');
    const file = store.fileFor('s');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        '# Memory for s',
        '# Memory for s\n\n- [m9] (2026-10-01) hand written',
      ),
      'utf8',
    );
    expect(store.all('s').map((e) => e.text)).toEqual(['hand written', 'first fact']);
    store.remember('s', 'second fact');
    expect(store.all('s').map((e) => e.text)).toEqual([
      'hand written',
      'first fact',
      'second fact',
    ]);
  });

  it('refuses credential-shaped text', () => {
    expect(() => store.remember('s', 'api key is sk-abcdefghijklmnopqrstuvwxyz012345')).toThrow(
      /credential/,
    );
    expect(() => store.remember('s', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toThrow(
      /credential/,
    );
    expect(() => store.remember('s', 'card 4111 1111 1111 1111 expires 2030')).toThrow(
      /credential/,
    );
    expect(() => store.remember('s', '-----BEGIN RSA PRIVATE KEY----- MIIEpAIBAAKCAQEA')).toThrow(
      /credential/,
    );
    expect(store.all('s')).toEqual([]);
    // Prose that merely mentions a password is the common case and must pass.
    expect(
      store.remember('s', 'the wifi password is written on the router sticker').id,
    ).toBeTruthy();
    expect(looksLikeCredential('order 1234567890123456789 shipped')).toBe(false);
  });

  it('refuses empty, multiline and oversized memories', () => {
    expect(() => store.remember('s', '   ')).toThrow(/empty/);
    expect(() => store.remember('s', 'line one\nline two')).toThrow(/single line/);
    expect(() => store.remember('s', 'x'.repeat(5_000))).toThrow(/limit is/);
  });
});

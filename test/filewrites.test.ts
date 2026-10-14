import { describe, expect, it } from 'vitest';
import { FileWriteTracker, normalizeWritePath } from '../src/core/filewrites.js';

const CWD = '/repo';
const mk = () => new FileWriteTracker({ cwd: CWD, platform: 'linux' });

describe('FileWriteTracker', () => {
  it('counts distinct destinations written OK', () => {
    const t = mk();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', false);
    t.start('2', 'write', { path: 'src/b.ts' });
    t.end('2', false);
    expect(t.count).toBe(2);
  });

  it('same destination via ./ is one', () => {
    const t = mk();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', false);
    t.start('2', 'write', { path: './src/a.ts' });
    t.end('2', false);
    expect(t.count).toBe(1);
  });

  it('relative and absolute spellings of the same file are one', () => {
    const t = mk();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', false);
    t.start('2', 'write', { path: '/repo/src/a.ts' });
    t.end('2', false);
    expect(t.count).toBe(1);
  });

  it('on Windows case aliases are one destination', () => {
    const t = new FileWriteTracker({ cwd: 'C:\\repo', platform: 'win32' });
    t.start('1', 'write', { path: 'src\\A.ts' });
    t.end('1', false);
    t.start('2', 'write', { path: 'C:\\repo\\src\\a.ts' });
    t.end('2', false);
    expect(t.count).toBe(1);
  });

  it('leading-space names are different files (no trim merge)', () => {
    const t = mk();
    t.start('1', 'write', { path: ' a.txt' });
    t.end('1', false);
    t.start('2', 'write', { path: 'a.txt' });
    t.end('2', false);
    expect(t.count).toBe(2);
  });

  it('a failed write counts nothing; a later OK retry counts one', () => {
    const t = mk();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', true);
    expect(t.count).toBe(0);
    t.start('2', 'write', { path: 'src/a.ts' });
    t.end('2', false);
    expect(t.count).toBe(1);
  });

  it('a gate refusal is an error end: nothing written', () => {
    const t = mk();
    t.start('1', 'write', { path: 'src/secrets.ts' });
    t.end('1', true);
    expect(t.count).toBe(0);
  });

  it('shell is excluded even with a path-looking payload', () => {
    const t = mk();
    t.start('1', 'shell', { command: 'echo x > src/a.ts' });
    t.end('1', false);
    expect(t.count).toBe(0);
  });

  it('two OK writes followed by a failed third still count the two', () => {
    const t = mk();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', false);
    t.start('2', 'write', { path: 'src/b.ts' });
    t.end('2', false);
    t.start('3', 'write', { path: 'src/c.ts' });
    t.end('3', true);
    expect(t.count).toBe(2);
  });

  it('ignores ends without start and writes without path', () => {
    const t = mk();
    t.end('fantasma', false);
    t.start('1', 'write', {});
    t.end('1', false);
    expect(t.count).toBe(0);
  });

  it('one tracker shared across attempts merges their writes', () => {
    // La dedup entre intentos la da la estructura (un tracker por run en
    // AttemptState); este canario fija la semantica que esa estructura usa.
    const t = mk();
    t.start('1', 'write', { path: 'src/a.ts' }); // intento 1
    t.end('1', false);
    t.start('2', 'write', { path: 'src/b.ts' }); // intento 2 (reintento transitorio)
    t.end('2', false);
    expect(t.count).toBe(2);
    t.start('3', 'write', { path: 'src/a.ts' }); // el intento 2 reescribe a
    t.end('3', false);
    expect(t.count).toBe(2);
  });
});

describe('normalizeWritePath', () => {
  it('resolves against the cwd', () => {
    expect(normalizeWritePath('src/a.ts', '/repo', 'linux')).toBe('/repo/src/a.ts');
  });
  it('lowercases on win32', () => {
    expect(normalizeWritePath('SRC\\A.TS', 'C:\\repo', 'win32')).toBe('c:\\repo\\src\\a.ts');
  });
});

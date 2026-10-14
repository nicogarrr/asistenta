import { describe, expect, it } from 'vitest';
import { FileWriteTracker, normalizeWritePath } from '../src/core/filewrites.js';

describe('FileWriteTracker', () => {
  it('counts distinct paths written OK', () => {
    const t = new FileWriteTracker();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', false);
    t.start('2', 'write', { path: 'src/b.ts' });
    t.end('2', false);
    expect(t.count).toBe(2);
  });

  it('same path written twice is one file, even with ./ variants', () => {
    const t = new FileWriteTracker();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', false);
    t.start('2', 'write', { path: './src/a.ts' });
    t.end('2', false);
    expect(t.count).toBe(1);
  });

  it('a failed write counts nothing; a later OK retry counts one', () => {
    const t = new FileWriteTracker();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', true); // fallo de la tool
    expect(t.count).toBe(0);
    t.start('2', 'write', { path: 'src/a.ts' });
    t.end('2', false); // reintento OK
    expect(t.count).toBe(1);
  });

  it('a gate refusal is an error end: nothing written', () => {
    const t = new FileWriteTracker();
    t.start('1', 'write', { path: 'src/secrets.ts' });
    t.end('1', true); // el gate lo bloqueo: la tool no escribio
    expect(t.count).toBe(0);
  });

  it('shell is excluded even with a path-looking payload', () => {
    const t = new FileWriteTracker();
    t.start('1', 'shell', { command: 'echo x > src/a.ts' });
    t.end('1', false);
    expect(t.count).toBe(0);
  });

  it('two OK writes followed by a failed third still count the two', () => {
    const t = new FileWriteTracker();
    t.start('1', 'write', { path: 'src/a.ts' });
    t.end('1', false);
    t.start('2', 'write', { path: 'src/b.ts' });
    t.end('2', false);
    t.start('3', 'write', { path: 'src/c.ts' });
    t.end('3', true);
    expect(t.count).toBe(2);
  });

  it('ignores ends without start and writes without path', () => {
    const t = new FileWriteTracker();
    t.end('fantasma', false);
    t.start('1', 'write', {});
    t.end('1', false);
    expect(t.count).toBe(0);
  });
});

describe('normalizeWritePath', () => {
  it('trims and normalizes', () => {
    expect(normalizeWritePath('  ./src//a.ts ')).toBe(normalizeWritePath('src/a.ts'));
  });
});

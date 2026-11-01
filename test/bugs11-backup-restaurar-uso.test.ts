import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'pa-bugs11-restaurar-'));
vi.mock('../src/paths.js', async (original) => ({
  ...(await original<typeof import('../src/paths.js')>()),
  paths: { ...(await original<typeof import('../src/paths.js')>()).paths, state: dir },
}));
vi.mock('../src/lifecycle.js', () => ({ assertNotRunning: () => {} }));

const { backupCommand } = await import('../src/backup-restore.js');
const { runBackup } = await import('../src/backup.js');

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

function capture(): { out: () => string } {
  let text = '';
  const grab = (s: string | Uint8Array): boolean => {
    text += String(s);
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
  return { out: () => text };
}

describe('pa backup restaurar sin fecha (bugs11)', () => {
  it('sin copias: enseña el uso, no «no hay copia de ninguna fecha»', async () => {
    const c = capture();
    expect(await backupCommand(['restaurar'])).toBe(2);
    expect(c.out()).toContain('pa backup restaurar <AAAA-MM-DD|ultima>');
    expect(c.out()).toContain('No hay copias todavía.');
    expect(c.out()).not.toContain('ninguna fecha');
  });

  it('con copias: no restaura nada a ciegas, pide la fecha y las lista', async () => {
    runBackup({ stateDir: dir, now: new Date(2026, 9, 28, 3, 0) });
    const c = capture();
    expect(await backupCommand(['restaurar'])).toBe(2);
    expect(c.out()).toContain('pa backup restaurar <AAAA-MM-DD|ultima>');
    expect(c.out()).toContain('2026-10-28');
    expect(c.out()).not.toContain('Restaurada');
  });

  it('«ultima» sin ninguna copia lo dice claro', async () => {
    rmSync(join(dir, 'backups'), { recursive: true, force: true });
    const c = capture();
    expect(await backupCommand(['restaurar', 'ultima'])).toBe(1);
    expect(c.out()).toContain('todavía no hay ninguna copia');
    expect(c.out()).not.toContain('no hay copia de ultima');
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'pa-bugs16-backupdir-'));
const state = join(dir, 'state');
const otro = join(dir, 'otro-disco');
vi.mock('../src/paths.js', async (original) => ({
  ...(await original<typeof import('../src/paths.js')>()),
  paths: { ...(await original<typeof import('../src/paths.js')>()).paths, state },
}));
vi.mock('../src/lifecycle.js', () => ({ assertNotRunning: () => {} }));

const { backupCommand } = await import('../src/backup-restore.js');
const { runBackup } = await import('../src/backup.js');

const prev = process.env.PA_BACKUP_DIR;
afterEach(() => {
  vi.restoreAllMocks();
  if (prev === undefined) delete process.env.PA_BACKUP_DIR;
  else process.env.PA_BACKUP_DIR = prev;
});
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

describe('pa backup con PA_BACKUP_DIR (las copias van a otro disco)', () => {
  it('lista y restaura las copias de PA_BACKUP_DIR, la misma carpeta donde las deja el daemon', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(state, 'memory'), { recursive: true });
    writeFileSync(join(state, 'memory', 'nota.md'), 'vive en Valencia\n');
    process.env.PA_BACKUP_DIR = otro;
    // Así la hace el daemon (cli.ts, backupIfDue): destDir = PA_BACKUP_DIR.
    runBackup({ stateDir: state, destDir: otro, now: new Date(2026, 9, 28, 3, 0) });
    expect(existsSync(join(state, 'backups'))).toBe(false);

    let c = capture();
    expect(await backupCommand([])).toBe(0);
    expect(c.out()).toContain('2026-10-28');
    expect(c.out()).not.toContain('No hay copias todavía');
    vi.restoreAllMocks();

    writeFileSync(join(state, 'memory', 'nota.md'), 'corrupto\n');
    c = capture();
    expect(await backupCommand(['restaurar', 'ultima'])).toBe(0);
    expect(c.out()).toContain('Restaurada');
    expect(readFileSync(join(state, 'memory', 'nota.md'), 'utf8')).toBe('vive en Valencia\n');
  });

  it('sin PA_BACKUP_DIR sigue usando <estado>/backups', async () => {
    delete process.env.PA_BACKUP_DIR;
    runBackup({ stateDir: state, now: new Date(2026, 9, 29, 3, 0) });
    const c = capture();
    expect(await backupCommand(['lista'])).toBe(0);
    expect(c.out()).toContain('2026-10-29');
    expect(c.out()).not.toContain('2026-10-28');
  });
});

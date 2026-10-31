import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAutoupdateState } from '../src/autoupdate.js';
import {
  AUTOUPDATE_PENDING,
  AUTOUPDATE_PENDING_BUSY,
  autoupdateStatusLine,
  maybeLaunchAutoupdate,
} from '../src/autoupdate-cli.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-medias-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = Date.now();
/** Como queda tras apagar el PC a mitad: marca «pending» y revisión recién hecha. */
function aMedias(extra: Record<string, unknown> = {}) {
  writeAutoupdateState(dir, {
    lastCheckAt: new Date(now - 60_000).toISOString(),
    pending: { from: 'a'.repeat(40), to: 'b'.repeat(40), at: new Date(now - 60_000).toISOString() },
    ...extra,
  });
}

describe('actualización a medias', () => {
  it('pa autoupdate status lo dice en llano', () => {
    aMedias();
    const line = autoupdateStatusLine(dir, {}, now);
    expect(line).toContain(AUTOUPDATE_PENDING.trim());
    expect(line).not.toMatch(/pending|git|npm/);
  });

  it('si ya la está arreglando, dice eso', () => {
    aMedias();
    mkdirSync(join(dir, 'autoupdate'), { recursive: true });
    writeFileSync(
      join(dir, 'autoupdate', 'en-curso.lock'),
      JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }),
    );
    expect(autoupdateStatusLine(dir, {}, now)).toContain(AUTOUPDATE_PENDING_BUSY.trim());
  });

  it('sin nada a medias no dice nada de más', () => {
    writeAutoupdateState(dir, { lastCheckAt: new Date(now).toISOString() });
    expect(autoupdateStatusLine(dir, {}, now)).not.toContain('a medias');
  });

  it('el vigilante la arregla ya aunque no toque revisar', () => {
    aMedias();
    const launch = vi.fn();
    expect(maybeLaunchAutoupdate(dir, 'cli.js', launch, {}, now)).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('y también con la autoactualización apagada', () => {
    aMedias({ off: true });
    const launch = vi.fn();
    expect(maybeLaunchAutoupdate(dir, 'cli.js', launch, { PA_AUTOUPDATE: '0' }, now)).toBe(true);
  });

  it('sin nada a medias, apagada sigue sin lanzar nada', () => {
    writeAutoupdateState(dir, { off: true });
    const launch = vi.fn();
    expect(maybeLaunchAutoupdate(dir, 'cli.js', launch, {}, now)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});

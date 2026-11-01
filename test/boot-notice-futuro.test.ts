import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeSendBootNotice } from '../src/boot-notice.js';

// Tras corregir la hora hacia atrás (reloj adelantado, arranque dual), el último
// aviso de arranque queda fechado en el futuro.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function statePath(lastSentAt: number): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-boot-futuro-'));
  dirs.push(d);
  const path = join(d, 'boot-notice.json');
  writeFileSync(path, JSON.stringify({ lastSentAt }));
  return path;
}
const facts = {
  model: 'modelo-x',
  tv: true,
  computerUse: true,
  mail: false,
  threads: 2,
  problems: ['modelo' as const],
};
const NOW = Date.parse('2026-10-31T10:00:00Z');
const H = 60 * 60_000;
const run = (path: string, now: number, send = vi.fn(async () => {})) =>
  maybeSendBootNotice({
    env: { PA_BOOT_NOTICE: '1' },
    statePath: path,
    ownerChatId: 42,
    send,
    facts,
    now: () => now,
  });

describe('aviso de arranque con el último envío fechado en el futuro', () => {
  it('un envío fechado días por delante ya no calla el aviso hasta esa fecha', async () => {
    const path = statePath(NOW + 3 * 24 * H);
    const send = vi.fn(async () => {});
    expect(await run(path, NOW, send)).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('tras ese aviso, un bucle de reinicios sigue frenado', async () => {
    const path = statePath(NOW + 3 * 24 * H);
    expect(await run(path, NOW)).toBe('sent');
    expect(await run(path, NOW + 60_000)).toBe('rate-limited');
  });

  it('un reloj un poco hacia atrás (menos de 1 h) sigue contando como reciente', async () => {
    expect(await run(statePath(NOW + 20 * 60_000), NOW)).toBe('rate-limited');
  });
});

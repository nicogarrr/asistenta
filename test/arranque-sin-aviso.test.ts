/** Nico (31/10 01:05): «se debería dar por hecho de que es sí». Un arranque normal no avisa. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_NOTICE_MIN_INTERVAL_MS,
  type BootFacts,
  maybeSendBootNotice,
} from '../src/boot-notice.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function statePath(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-boot-quiet-'));
  dirs.push(d);
  return join(d, 'boot-notice.json');
}
const ok = { model: 'modelo-x', tv: true, computerUse: true, mail: false, threads: 2 };
const sinClave = { ...ok, problems: ['modelo' as const] };

describe('arranque sin aviso', () => {
  it('un arranque normal no manda ningún mensaje por Telegram', async () => {
    const send = vi.fn(async () => {});
    const path = statePath();
    for (let i = 0; i < 3; i++) {
      const now = 1_000_000 + i * 2 * BOOT_NOTICE_MIN_INTERVAL_MS;
      await maybeSendBootNotice({
        statePath: path,
        ownerChatId: 42,
        send,
        facts: ok,
        now: () => now,
      });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('sin clave del modelo: una sola línea clara, y no se repite al reiniciar', async () => {
    const send = vi.fn(async (_chat: string, _text: string) => {});
    const path = statePath();
    let t = 5_000_000;
    const run = (facts: BootFacts = sinClave) =>
      maybeSendBootNotice({ statePath: path, ownerChatId: 42, send, facts, now: () => t });
    expect(await run()).toBe('sent');
    const text = send.mock.calls[0]?.[1] ?? '';
    expect(text).not.toContain('\n');
    expect(text).toMatch(/clave del modelo/);
    expect(text).not.toMatch(/modelo-x|Tele:|PC:|Correo:|\/funciones|✅/);
    t += 3 * BOOT_NOTICE_MIN_INTERVAL_MS;
    expect(await run()).toBe('repeated');
    expect(send).toHaveBeenCalledTimes(1);
    // Arreglado: un arranque normal no dice nada; si vuelve a faltar, se avisa otra vez.
    t += 3 * BOOT_NOTICE_MIN_INTERVAL_MS;
    expect(await run(ok)).toBe('quiet');
    t += 3 * BOOT_NOTICE_MIN_INTERVAL_MS;
    expect(await run()).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('el daemon avisa de la clave que falta antes de salir, al chat del dueño', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const fail = cli.indexOf('if (!providerOk');
    expect(fail).toBeGreaterThan(0);
    expect(cli.indexOf("problems: ['modelo']", fail)).toBeGreaterThan(fail);
    expect(cli.indexOf('telegramBotSend(token)', fail)).toBeGreaterThan(fail);
  });
});

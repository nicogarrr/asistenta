/** Aviso de arranque (solo si algo falla) y banner de consola (src/boot-notice.ts). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_NOTICE_MIN_INTERVAL_MS,
  bootBanner,
  bootNoticeEnabled,
  bootProblemText,
  maybeSendBootNotice,
} from '../src/boot-notice.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function statePath(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-boot-'));
  dirs.push(d);
  return join(d, 'boot-notice.json');
}

const facts = {
  model: 'modelo-x',
  tv: true,
  computerUse: true,
  mail: false,
  threads: 2,
  problems: ['modelo' as const],
};
const ON = { PA_BOOT_NOTICE: '1' };

describe('aviso de arranque', () => {
  it('encendido por defecto; PA_BOOT_NOTICE=0 lo apaga y no manda nada', async () => {
    const send = vi.fn(async () => {});
    expect(bootNoticeEnabled({})).toBe(true);
    expect(bootNoticeEnabled({ PA_BOOT_NOTICE: '1' })).toBe(true);
    for (const v of ['0', 'off', 'false', 'NO', ' 0 '])
      expect(bootNoticeEnabled({ PA_BOOT_NOTICE: v })).toBe(false);
    expect(
      await maybeSendBootNotice({
        env: { PA_BOOT_NOTICE: '0' },
        statePath: statePath(),
        ownerChatId: 42,
        send,
        facts,
      }),
    ).toBe('off');
    expect(send).not.toHaveBeenCalled();
  });

  it('con un problema: una línea al chat privado del dueño', async () => {
    const send = vi.fn(async (_chat: string, _text: string) => {});
    const path = statePath();
    expect(
      await maybeSendBootNotice({
        env: ON,
        statePath: path,
        ownerChatId: 42,
        send,
        facts,
        now: () => 1_000_000,
      }),
    ).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('42');
    const text = send.mock.calls[0]?.[1] ?? '';
    expect(text).toBe(bootProblemText(['modelo']));
    expect(text).not.toContain('Tele:');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      lastSentAt: 1_000_000,
      told: ['modelo'],
      lastResult: 'sent',
      lastResultAt: new Date(1_000_000).toISOString(),
    });
  });

  it('sin dueño conocido no manda nada (nunca al último chat ni a un grupo)', async () => {
    const send = vi.fn(async () => {});
    expect(
      await maybeSendBootNotice({
        env: ON,
        statePath: statePath(),
        ownerChatId: null,
        send,
        facts,
      }),
    ).toBe('no-owner');
    expect(send).not.toHaveBeenCalled();
  });

  it('como mucho uno cada 10 minutos y nunca el mismo problema dos veces', async () => {
    const send = vi.fn(async () => {});
    const path = statePath();
    let t = 5_000_000;
    const run = () =>
      maybeSendBootNotice({ env: ON, statePath: path, ownerChatId: 42, send, facts, now: () => t });
    expect(await run()).toBe('sent');
    t += 60_000;
    expect(await run()).toBe('rate-limited');
    t += BOOT_NOTICE_MIN_INTERVAL_MS;
    expect(await run()).toBe('repeated');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('un envío que falla también cuenta (se apunta antes de enviar)', async () => {
    const path = statePath();
    const failing = vi.fn(async () => {
      throw new Error('red caída');
    });
    expect(
      await maybeSendBootNotice({
        env: ON,
        statePath: path,
        ownerChatId: 42,
        send: failing,
        facts,
        now: () => 10_000_000,
      }),
    ).toBe('failed');
    const send = vi.fn(async () => {});
    expect(
      await maybeSendBootNotice({
        env: ON,
        statePath: path,
        ownerChatId: 42,
        send,
        facts,
        now: () => 10_000_100,
      }),
    ).toBe('rate-limited');
    expect(send).not.toHaveBeenCalled();
  });

  it('fichero roto o reloj hacia atrás: no revienta', async () => {
    const path = statePath();
    writeFileSync(path, '{roto');
    const send = vi.fn(async () => {});
    expect(
      await maybeSendBootNotice({
        env: ON,
        statePath: path,
        ownerChatId: 42,
        send,
        facts,
        now: () => 50_000_000,
      }),
    ).toBe('sent');
    expect(
      await maybeSendBootNotice({
        env: ON,
        statePath: path,
        ownerChatId: 42,
        send,
        facts,
        now: () => 49_000_000,
      }),
    ).toBe('rate-limited');
  });

  it('banner: una sola línea para la consola', () => {
    const line = bootBanner({ ...facts, panelUrl: 'http://127.0.0.1:7777' });
    expect(line).not.toContain('\n');
    expect(line.startsWith('Asistenta lista ✅')).toBe(true);
    expect(line).toContain('modelo modelo-x');
    expect(line).toContain('panel http://127.0.0.1:7777');
    expect(bootProblemText(['modelo'])).not.toContain('\n');
  });

  it('el daemon lo cablea tras «daemon ready» y PA_BOOT_NOTICE está en .env.example', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const ready = cli.indexOf("log.info('daemon ready'");
    expect(ready).toBeGreaterThan(0);
    expect(cli.indexOf('maybeSendBootNotice({', ready)).toBeGreaterThan(ready);
    expect(cli).toContain('ownerChatId: vigilanteOwnerId');
    const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(env).toMatch(/^# PA_BOOT_NOTICE=1 .*0 = no avisar/m);
  });
});

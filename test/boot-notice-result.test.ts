/** El resultado del aviso «Asistenta lista ✅» se guarda y `pa autostart status` lo enseña. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_NOTICE_FILE,
  formatBootNoticeResult,
  maybeSendBootNotice,
  readBootNoticeResult,
} from '../src/boot-notice.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function statePath(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-boot-res-'));
  dirs.push(d);
  return join(d, BOOT_NOTICE_FILE);
}
const facts = { model: 'm', tv: false, computerUse: false, mail: false, threads: 0 };
const NOW = Date.parse('2026-10-30T18:00:00Z');

describe('resultado del aviso de arranque', () => {
  it('cada resultado queda guardado con su hora', async () => {
    const cases: [Parameters<typeof maybeSendBootNotice>[0]['env'], number | null, string][] = [
      [{ PA_BOOT_NOTICE: '0' }, 1, 'off'],
      [{}, null, 'no-owner'],
      [{}, 1, 'sent'],
    ];
    for (const [env, owner, want] of cases) {
      const path = statePath();
      const result = await maybeSendBootNotice({
        env,
        now: () => NOW,
        statePath: path,
        ownerChatId: owner,
        facts,
        send: vi.fn(async () => {}),
      });
      expect(result).toBe(want);
      expect(readBootNoticeResult(path)).toEqual({ result: want, at: '2026-10-30T18:00:00.000Z' });
    }
  });

  it('un fallo de Telegram queda como «failed» y no borra la hora del último envío', async () => {
    const path = statePath();
    const send = vi.fn(async () => {
      throw new Error('red caída');
    });
    const deps = { env: {}, now: () => NOW, statePath: path, ownerChatId: 7, facts, send };
    expect(await maybeSendBootNotice(deps)).toBe('failed');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    expect(state).toMatchObject({ lastSentAt: NOW, lastResult: 'failed' });
    // El límite de uno cada 10 min sigue funcionando con el resultado guardado al lado.
    expect(await maybeSendBootNotice({ ...deps, now: () => NOW + 60_000 })).toBe('rate-limited');
    expect(send).toHaveBeenCalledTimes(1);
    expect(readBootNoticeResult(path)?.result).toBe('rate-limited');
  });

  it('un fichero antiguo (solo lastSentAt), roto o con un resultado raro no rompe nada', () => {
    const path = statePath();
    expect(readBootNoticeResult(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ lastSentAt: NOW }));
    expect(readBootNoticeResult(path)).toBeUndefined();
    writeFileSync(path, '{roto');
    expect(readBootNoticeResult(path)).toBeUndefined();
    writeFileSync(
      path,
      JSON.stringify({ lastResult: 'quizá', lastResultAt: '2026-10-30T18:00:00Z' }),
    );
    expect(readBootNoticeResult(path)).toBeUndefined();
  });

  it('la línea de pa autostart status, en español y con qué hacer', () => {
    const now = new Date(NOW + 5 * 60_000);
    const at = new Date(NOW).toISOString();
    expect(formatBootNoticeResult(undefined, now)).toBe(
      'Aviso «Asistenta lista ✅» del último arranque: ninguno registrado todavía.',
    );
    expect(formatBootNoticeResult({ result: 'sent', at }, now)).toBe(
      'Aviso «Asistenta lista ✅» del último arranque, hace 5 min: enviado a tu chat privado ✅.',
    );
    expect(formatBootNoticeResult({ result: 'no-owner', at }, now)).toContain(
      'pa iniciar --solo-comprobar',
    );
    expect(formatBootNoticeResult({ result: 'off', at }, now)).toContain('PA_BOOT_NOTICE=0');
    expect(formatBootNoticeResult({ result: 'failed', at }, now)).toContain('❌');
  });
});

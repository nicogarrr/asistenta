/**
 * Primer uso en Windows: si el panel web no arranca (PA_WEB_PORT mal puesto o falta
 * PA_WEB_TOKEN) el aviso salía solo en la consola del PC, que casi nunca está a la
 * vista. Ahora llega también por Telegram, una vez, en castellano llano.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOT_NOTICE_MIN_INTERVAL_MS, maybeSendBootNotice } from '../src/boot-notice.js';
import { panelStartPlan } from '../src/panel-doctor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function statePath(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-panel-aviso-'));
  dirs.push(d);
  return join(d, 'boot-notice.json');
}
const base = { tv: false, computerUse: false, mail: false };
const env = { PA_BOOT_NOTICE: '1' };

function problemOf(e: NodeJS.ProcessEnv) {
  const plan = panelStartPlan(e);
  return plan.kind === 'problem' ? [plan.problem] : [];
}

describe('panel que no arranca: aviso por Telegram', () => {
  it('el plan dice qué falla: puerto o token; si todo está bien, nada', () => {
    expect(problemOf({ PA_WEB_PORT: 'abc', PA_WEB_TOKEN: 'x'.repeat(30) })).toEqual([
      'panel-puerto',
    ]);
    expect(problemOf({ PA_WEB_PORT: '8787' })).toEqual(['panel-token']);
    expect(problemOf({ PA_WEB_PORT: '8787', PA_WEB_TOKEN: 'x'.repeat(30) })).toEqual([]);
    expect(problemOf({})).toEqual([]);
  });

  it('sin token: un mensaje claro al dueño, y no se repite en cada reinicio', async () => {
    const path = statePath();
    const send = vi.fn(async (_chat: string, _text: string) => {});
    const facts = { ...base, problems: problemOf({ PA_WEB_PORT: '8787' }) };
    let now = 1_000_000;
    const deps = { env, statePath: path, ownerChatId: 42, send, facts, now: () => now };
    expect(await maybeSendBootNotice(deps)).toBe('sent');
    const text = send.mock.calls[0]?.[1] ?? '';
    expect(send.mock.calls[0]?.[0]).toBe('42');
    expect(text).toMatch(/^El panel web no se ha encendido: falta PA_WEB_TOKEN/);
    expect(text).toContain('24 o más letras y números al azar');
    expect(text).not.toMatch(/undefined|Error|daemon|sin PA_WEB_TOKEN/);
    now += BOOT_NOTICE_MIN_INTERVAL_MS * 10;
    expect(await maybeSendBootNotice(deps)).toBe('repeated');
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).told).toContain('panel-token');
  });

  it('puerto mal puesto: dice qué número poner', async () => {
    const send = vi.fn(async (_chat: string, _text: string) => {});
    const facts = { ...base, problems: problemOf({ PA_WEB_PORT: '80a', PA_WEB_TOKEN: 'y' }) };
    expect(
      await maybeSendBootNotice({ env, statePath: statePath(), ownerChatId: 7, send, facts }),
    ).toBe('sent');
    const text = send.mock.calls[0]?.[1] ?? '';
    expect(text).toContain('PA_WEB_PORT');
    expect(text).toContain('8787');
    expect(text).toContain('reinicia Asistenta');
  });

  it('arreglado y vuelto a romper: avisa otra vez; panel apagado o bien: silencio', async () => {
    const path = statePath();
    const send = vi.fn(async (_chat: string, _text: string) => {});
    let now = 5_000_000;
    const run = (e: NodeJS.ProcessEnv) =>
      maybeSendBootNotice({
        env,
        statePath: path,
        ownerChatId: 1,
        send,
        facts: { ...base, problems: problemOf(e) },
        now: () => now,
      });
    expect(await run({ PA_WEB_PORT: '8787' })).toBe('sent');
    now += BOOT_NOTICE_MIN_INTERVAL_MS * 2;
    expect(await run({ PA_WEB_PORT: '8787', PA_WEB_TOKEN: 'z'.repeat(30) })).toBe('quiet');
    expect(await run({})).toBe('quiet');
    now += BOOT_NOTICE_MIN_INTERVAL_MS * 2;
    expect(await run({ PA_WEB_PORT: '8787' })).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('el daemon pasa el problema del panel al aviso de arranque', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('const panel = await panelBootFacts(panelPlan, panelStarted);');
    expect(src).toContain('problems: panel.problems,');
  });
});

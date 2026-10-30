import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isQaChatId, QaChannel } from '../src/channels/qa.js';
import type { Inbound } from '../src/channels/types.js';
import { isOwnerDm } from '../src/vigilante.js';
import { isWindows } from './helpers/platform.js';

/**
 * PA_QA_OWNER_DM=1 (solo pruebas): en el canal de QA, una línea `"owner": true` entra
 * como el DM del dueño, para probar por el daemon real /resumen hoy, /correo y el
 * resumen diario. Apagado por defecto, y lo que sale hacia ese chat se queda en el
 * outbox: nunca toca Telegram.
 */
const OWNER = 42;

async function run(lines: Array<Record<string, unknown>>): Promise<{
  got: Inbound[];
  ch: QaChannel;
  dir: string;
  started: Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'qa-owner-'));
  writeFileSync(join(dir, 'SANDBOX'), '');
  const ch = new QaChannel({ token: '1:x', allowedUserIds: [OWNER], dir, pollMs: 20 });
  const got: Inbound[] = [];
  const started = ch.start({
    onMessage: (i: Inbound) => {
      got.push(i);
    },
    log: () => {},
  } as unknown as Parameters<QaChannel['start']>[0]);
  for (const l of lines) appendFileSync(join(dir, 'inbox.jsonl'), `${JSON.stringify(l)}\n`);
  await new Promise((r) => setTimeout(r, 200));
  return { got, ch, dir, started };
}

afterEach(() => {
  delete process.env.PA_QA_OWNER_DM;
  vi.restoreAllMocks();
});

describe.skipIf(isWindows)('canal de QA: DM del dueño solo con PA_QA_OWNER_DM=1', () => {
  it('apagado por defecto: «owner» se ignora y el caso sigue en un chat de QA', async () => {
    const { got, ch, started } = await run([{ case: 'O1', text: '/resumen hoy', owner: true }]);
    expect(got).toHaveLength(1);
    expect(isQaChatId(got[0]?.chatId ?? '')).toBe(true);
    expect(isOwnerDm(got[0] as Inbound, OWNER)).toBe(false);
    await ch.stop();
    await started.catch(() => {});
  });

  it('encendido: entra como el DM del dueño y lo que sale se queda en el outbox', async () => {
    process.env.PA_QA_OWNER_DM = '1';
    const parentSend = vi.spyOn(Object.getPrototypeOf(QaChannel.prototype), 'send');
    const { got, ch, dir, started } = await run([
      { case: 'O1', text: '/resumen hoy', owner: true },
      { case: 'G1', text: 'hola' },
    ]);
    expect(got.map((i) => i.chatId)).toEqual([String(OWNER), expect.any(String)]);
    expect(isOwnerDm(got[0] as Inbound, OWNER)).toBe(true);
    expect(isQaChatId(got[1]?.chatId ?? '')).toBe(true);

    await ch.send({ channel: 'telegram', account: 'main', chatId: String(OWNER), text: 'tu día' });
    const approval = await ch.offerApproval('1', String(OWNER), '¿Permito shell?\npagar');
    expect(approval.approved).toBe(false);
    expect(parentSend).not.toHaveBeenCalled();

    const out = readFileSync(join(dir, 'outbox.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { case: string; kind: string; text?: string });
    expect(out.filter((l) => l.case === 'O1').map((l) => l.kind)).toEqual([
      'in',
      'text',
      'approval',
    ]);
    await ch.stop();
    await started.catch(() => {});
  });

  it('un chat que no es de QA ni el del dueño sigue yendo a Telegram', async () => {
    process.env.PA_QA_OWNER_DM = '1';
    const parentSend = vi
      .spyOn(Object.getPrototypeOf(QaChannel.prototype), 'send')
      .mockResolvedValue('m1');
    const { ch, started } = await run([]);
    await ch.send({ channel: 'telegram', account: 'main', chatId: '777', text: 'x' });
    expect(parentSend).toHaveBeenCalledTimes(1);
    await ch.stop();
    await started.catch(() => {});
  });
});

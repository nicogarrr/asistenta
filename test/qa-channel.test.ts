import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isQaChatId, looksLikeMoney, QA_CHAT_BASE, QaChannel } from '../src/channels/qa.js';
import type { Inbound } from '../src/channels/types.js';

describe('canal de QA', () => {
  it('solo trata como QA los ids muy por encima de los de Telegram', () => {
    expect(isQaChatId(QA_CHAT_BASE + 1)).toBe(true);
    expect(isQaChatId('8258546109')).toBe(false);
    expect(isQaChatId('abc')).toBe(false);
  });

  it('detecta peticiones de dinero para denegarlas', () => {
    expect(looksLikeMoney(null, '¿Permito shell?\nPagar el billete con la tarjeta')).toBe(true);
    expect(looksLikeMoney({ tool: 'purchase' }, 'x')).toBe(true);
    expect(looksLikeMoney(null, '¿Permito download?\nDescargar un PDF')).toBe(false);
  });

  it('entra por inbox, sale por outbox, aprueba lo no monetario y deniega el dinero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-'));
    const ch = new QaChannel({ token: '1:x', allowedUserIds: [42], dir, pollMs: 20 });
    const got: Inbound[] = [];
    // El arranque real de Telegram necesita red; el canal de QA solo necesita el inbox.
    const handlers = {
      onMessage: (i: Inbound) => {
        got.push(i);
      },
      log: () => {},
    };
    const started = ch.start(handlers);
    appendFileSync(join(dir, 'inbox.jsonl'), `${JSON.stringify({ case: 'A1', text: 'hola' })}\n`);
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toHaveLength(1);
    expect(got[0]?.authorised).toBe(true);
    expect(isQaChatId(got[0]?.chatId ?? '')).toBe(true);
    const chatId = got[0]?.chatId ?? '';

    await ch.send({ channel: 'telegram', account: 'main', chatId, text: 'respuesta' });
    expect((await ch.offerApproval('1', chatId, '¿Permito download?\nbajar un pdf')).approved).toBe(
      true,
    );
    expect(
      (await ch.offerApproval('2', chatId, '¿Permito shell?\npagar con tarjeta')).approved,
    ).toBe(false);

    const lines = readFileSync(join(dir, 'outbox.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { case: string; kind: string; text?: string });
    expect(lines.every((l) => l.case === 'A1')).toBe(true);
    expect(lines.map((l) => l.kind)).toEqual(['in', 'text', 'approval', 'approval']);
    await ch.stop();
    await started.catch(() => {});
  });
});

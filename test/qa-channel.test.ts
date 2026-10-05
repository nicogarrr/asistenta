import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isQaChatId,
  looksLikeMoney,
  QA_CHAT_BASE,
  QaChannel,
  qaApproves,
} from '../src/channels/qa.js';
import type { Inbound } from '../src/channels/types.js';
import { isWindows } from './helpers/platform.js';

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

  it.skipIf(isWindows)(
    'entra por inbox, sale por outbox, aprueba lo no monetario y deniega el dinero',
    async () => {
      // QaChannel refuses to start on Windows on purpose: the real instance runs there,
      // and a QA channel that shares a machine with the live one is a way to send
      // commands to the user's own agent. The guard is in the constructor, so the test
      // has to skip there too.
      const dir = mkdtempSync(join(tmpdir(), 'qa-'));
      writeFileSync(join(dir, 'SANDBOX'), '');
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
      expect(
        (await ch.offerApproval('1', chatId, '¿Permito download?\nbajar un pdf')).approved,
      ).toBe(true);
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
    },
  );

  it('deniega todo lo que huela a dinero o no se reconozca', () => {
    const denied = [
      '¿Permito download?\nQuiero hacer payments',
      '¿Permito download?\nsubscription anual',
      '¿Permito download?\nlas purchases del mes',
      '¿Permito download?\nlas compras',
      '¿Permito download?\n20 euros',
      '¿Permito download?\npagar por Bizum',
      '¿Permito download?\n500 USD',
      '¿Permito download?\n50 $',
      '¿Permito browser?\nBook the flight for $300',
      '¿Permito download?\nun pedido de Glovo',
      '¿Permito download?\nreservar el tren',
      '¿Permito browser?\nAdd to basket and proceed',
      '¿Permito browser?\nRenovar el abono',
      '¿Permito browser?\nfinalizar el pedido',
      '¿Permito browser?\nañadir al carrito',
      '¿Permito browser?\nview cart',
      '¿Permito shell?\nejecutar yt-dlp',
      '¿Permito computer?\nabrir una ventana',
      '¿Permito write?\nescribir 500 USD en pagos.txt',
      '¿Permito herramienta_nueva?\nalgo',
      'texto sin formato',
    ];
    for (const q of denied) expect(qaApproves(q), q).toBe(false);
    const ok = [
      '¿Permito download?\nDescargar un PDF de w3.org',
      '¿Permito renfe?\nBuscar trenes Madrid-Barcelona',
      '¿Permito write?\nCrear pruebas/hola.txt',
      '¿Abro www.renfe.com?\nBuscar horarios',
    ];
    for (const q of ok) expect(qaApproves(q), q).toBe(true);
  });

  it('se niega a arrancar sin el fichero marcador de sandbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-'));
    expect(() => new QaChannel({ token: '1:x', allowedUserIds: [42], dir })).toThrow(/rechazado/);
  });
});

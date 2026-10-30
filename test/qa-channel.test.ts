import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// El canal de QA hereda de TelegramChannel: sin esto, start() abría polling real contra
// api.telegram.org y stop() esperaba un getUpdates de red sin límite. Con la red lenta o la
// máquina cargada, el test se colgaba hasta los 60 s. El bot falso nunca toca la red.
vi.mock('grammy', () => {
  const api = new Proxy({ config: { use: () => {} } } as Record<string, unknown>, {
    get: (o, k) => (k in o ? o[k as string] : async () => true),
  });
  class FakeBot {
    api = api;
    #end: (() => void) | null = null;
    catch(): void {}
    on(): void {}
    use(): void {}
    start(): Promise<void> {
      return new Promise((resolve) => {
        this.#end = resolve;
      });
    }
    async stop(): Promise<void> {
      this.#end?.();
    }
  }
  return {
    Bot: FakeBot,
    GrammyError: class extends Error {},
    HttpError: class extends Error {},
    InlineKeyboard: class {},
    InputFile: class {},
  };
});

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

  it('el arnes solo aprueba la contrasena del login de saucedemo.com, nada mas', () => {
    const head = '\u00bfPermito esta acci\u00f3n en el navegador?\n';
    const reason = '\nMotivo: touches a password, code or card field';
    const sauce = `${head}Elemento: input \u00b7 password \u00b7 Password \u00b7 password @@ https://www.saucedemo.com/${reason}`;
    expect(qaApproves(sauce)).toBe(true);
    // Con titulo de pagina (formatApprovalQuestion une los trozos con " \u00b7 "): tambien se aprueba.
    expect(qaApproves(`${sauce.replace(reason, '')} \u00b7 Swag Labs${reason}`)).toBe(true);
    expect(qaApproves(`${sauce.replace(reason, '')} | Swag Labs${reason}`)).toBe(true);
    // El sufijo no puede traer otro "@@" ni "@" que cuele otra URL.
    expect(
      qaApproves(
        `${sauce.replace(reason, '')} \u00b7 Swag Labs @@ https://pay.example.com/${reason}`,
      ),
    ).toBe(false);
    // Otro sitio, otro host que lo imita, o un campo de tarjeta: se deniega.
    expect(qaApproves(sauce.replace('www.saucedemo.com', 'www.otra-tienda.com'))).toBe(false);
    expect(
      qaApproves(sauce.replace('https://www.saucedemo.com/', 'https://www.saucedemo.com.evil.io/')),
    ).toBe(false);
    expect(qaApproves(sauce.replace('password \u00b7 Password \u00b7 password', 'cc-number'))).toBe(
      false,
    );
    expect(qaApproves(sauce.replace('Elemento: input', 'Elemento: button'))).toBe(false);
    // Un nombre de campo que trae su propio "@@" no puede colar otra URL.
    expect(
      qaApproves(
        `${head}Elemento: input \u00b7 password @@ https://www.saucedemo.com/ @@ https://pay.example.com/${reason}`,
      ),
    ).toBe(false);
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
      // Ni una conexión de red: el canal de QA vive de ficheros.
      const connect = vi.spyOn(Socket.prototype, 'connect');
      const started = ch.start(handlers);
      appendFileSync(join(dir, 'inbox.jsonl'), `${JSON.stringify({ case: 'A1', text: 'hola' })}\n`);
      // Espera a que llegue (sondeo cada 20 ms), sin un plazo fijo que la carga pueda pisar.
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 10_000, interval: 20 });
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
      expect(connect).not.toHaveBeenCalled();
      connect.mockRestore();
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
      '¿Permito download?\nun pedido de comida',
      '¿Permito download?\nreservar el tren',
      '¿Permito browser?\nRenovar el abono',
      '¿Permito browser?\nfinalizar el pedido',
      '¿Abro www.paypal.com?\nabrir paypal.com',
      '¿Abro checkout.glovoapp.com?\nir al checkout',
      '¿Permito shell?\nejecutar yt-dlp',
      '¿Permito computer?\nabrir una ventana',
      '¿Permito write?\nescribir 500 USD en pagos.txt',
      '¿Permito browser?\nConfirmar viaje con Uber',
      '¿Permito browser?\nSolicitar UberX',
      '¿Permito browser?\nRequest ride',
      '¿Permito browser?\nConfirm ride',
      '¿Permito herramienta_nueva?\nalgo',
      // renfe ya no es una tool del runtime: no se auto-aprueba.
      '¿Permito renfe?\nBuscar trenes Madrid-Barcelona',
      'texto sin formato',
    ];
    for (const q of denied) expect(qaApproves(q), q).toBe(false);
    const ok = [
      '¿Permito download?\nDescargar un PDF de w3.org',
      '¿Permito write?\nCrear pruebas/hola.txt',
      '¿Permito reminder?\nRecordatorio: apagar el horno',
      '¿Abro www.renfe.com?\nBuscar horarios',
      '¿Abro uber.com?\nla pagina quiere llevarte a uber.com',
      '¿Abro glovoapp.com?\nabrir glovoapp.com en el navegador',
      '¿Abro booking.com?\nabrir booking.com en el navegador',
      '¿Permito browser?\nElemento: input · text · ¿Cuál es tu dirección? @@ https://glovoapp.com/es/es',
      '¿Permito browser?\nañadir al carrito',
      '¿Permito browser?\nview cart',
    ];
    for (const q of ok) expect(qaApproves(q), q).toBe(true);
  });

  it('se niega a arrancar sin el fichero marcador de sandbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-'));
    expect(() => new QaChannel({ token: '1:x', allowedUserIds: [42], dir })).toThrow(/rechazado/);
  });
});

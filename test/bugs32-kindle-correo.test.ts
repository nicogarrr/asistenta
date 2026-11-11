import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliverToKindle,
  KINDLE_MAIL_MAX_BYTES,
  type KindleDeliverDeps,
} from '../src/bandeja/kindle.js';
import { type BandejaItem, BandejaStore } from '../src/bandeja/store.js';

// bugs-32 (11 nov 2026): un PDF de 19 MB (el máximo que baja un bot de Telegram es 20) se
// mandaba por correo al Kindle sin mirar el tamaño: en base64 son ~26 MB, más de lo que deja
// Gmail/Outlook, y tras subirlo entero llegaba «El correo al Kindle falló (552 …)».

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs32-kmail-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function pdfItem(): BandejaItem {
  return store.add(
    CHAT,
    { kind: 'pdf', fileId: 'F1', fileName: 'informe.pdf', mimeType: 'application/pdf' },
    NOV11,
    '2026-11-11',
  ).item;
}

function deps(bytes: Buffer, send: ReturnType<typeof vi.fn>): KindleDeliverDeps {
  return {
    store,
    chatId: CHAT,
    fetchRaw: async () => '',
    download: async () => bytes,
    convert: async () => ({ ok: false, reason: 'no-converter', message: 'sin calibre' }),
    sendFile: async () => undefined,
    env: { PA_KINDLE_EMAIL: 'nico_x@kindle.com' },
    now: () => NOV11,
    mail: {
      account: async () => ({
        address: 'asistenta@gmail.com',
        password: 'x',
        imapHost: 'i',
        imapPort: 993,
        smtpHost: 's',
        smtpPort: 465,
      }),
      send: send as never,
    },
  };
}

describe('kindle: correo demasiado grande', () => {
  it('un PDF de 19 MB no se intenta mandar por correo; se dice por qué y qué hacer', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(19_000_000, 0x20)]);
    const text = await deliverToKindle({ item: pdfItem() }, deps(big, send));
    expect(send).not.toHaveBeenCalled();
    expect(text).toMatch(/pesa 19 MB: no cabe en un correo/);
    expect(text).toMatch(/USB/);
  });

  it('uno pequeño sí va', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const small = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200_000, 0x20)]);
    const text = await deliverToKindle({ item: pdfItem() }, deps(small, send));
    expect(send).toHaveBeenCalledTimes(1);
    expect(text).toContain('📧 Enviado a tu Kindle');
  });

  it('el tope deja sitio al base64 por debajo de 25 MB', () => {
    expect(Math.ceil(KINDLE_MAIL_MAX_BYTES / 3) * 4).toBeLessThan(25_000_000);
  });
});

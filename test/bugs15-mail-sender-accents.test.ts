import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectForCleanup } from '../src/mail/cleanup.js';
import type { ImapLike, ScannedMail } from '../src/mail/scan.js';
import { createMailRulesTool } from '../src/tools/mail-rules.js';

const mail = (from: string): ScannedMail =>
  ({ uid: 1, from, fromName: '', subject: 'x', date: 0, headers: {} }) as unknown as ScannedMail;

describe('«limpia lo de …»: el remitente dicho con tilde o mayúsculas encuentra sus correos', () => {
  const mails = [mail('ofertas@iberia.example'), mail('ana@amiga.example')];

  it('con tilde', () => {
    const { picked } = selectForCleanup(mails, { remitente: 'Ibéria' });
    expect(picked.map((m) => m.from)).toEqual(['ofertas@iberia.example']);
  });

  it('sin tilde sigue igual, y lo que no es no entra', () => {
    expect(selectForCleanup(mails, { remitente: ' IBERIA ' }).picked).toHaveLength(1);
    expect(selectForCleanup(mails, { remitente: 'renfe' }).picked).toHaveLength(0);
  });
});

describe('«date de baja de …»: el remitente con tilde también encuentra la lista', () => {
  it('baja_vista con «Ibéria» prepara el lote de iberia', async () => {
    const LINK = 'List-Unsubscribe: <https://iberia.example/baja>\r\n';
    const rows = [
      { from: 'news@iberia.example', h: LINK },
      { from: 'promo@c.example', h: 'List-Unsubscribe: <https://c.example/baja>\r\n' },
    ];
    const imap: ImapLike = {
      connect: async () => {},
      mailboxOpen: async () => ({}),
      search: async () => rows.map((_, i) => i + 1),
      fetchOne: async (uid) => {
        const r = rows[Number(uid) - 1];
        const envelope = { from: [{ address: r?.from }], subject: 'x', date: new Date() };
        return r && { uid: Number(uid), envelope, headers: Buffer.from(r.h) };
      },
      logout: async () => {},
    };
    const tool = createMailRulesTool({
      account: async () => ({
        address: 'n@x.example',
        password: 'p',
        imapHost: 'h',
        imapPort: 993,
        smtpHost: 's',
        smtpPort: 465,
      }),
      imap: () => imap,
      rulesFile: join(mkdtempSync(join(tmpdir(), 'bugs15-unsub-')), 'r.json'),
      post: async () => 200,
    });
    const text = (
      (await tool.execute('t', { action: 'baja_vista', remitente: 'Ibéria' } as never))
        .content[0] as { text: string }
    ).text;
    expect(text).toContain('news@iberia.example');
    expect(text).not.toContain('promo@c.example');
    expect(text).toMatch(/lote [0-9a-f]+/);
  });
});

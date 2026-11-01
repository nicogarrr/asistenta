import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImapMover } from '../src/mail/move.js';
import { createMailRulesTool, mailMoveFailText } from '../src/tools/mail-rules.js';

// Al limpiar un lote aprobado, un error crudo del servidor IMAP no debe llegar al chat:
// línea clara en castellano, el crudo solo al log.
const account = {
  address: 'n@x.example',
  password: 'p',
  imapHost: 'h',
  imapPort: 993,
  smtpHost: 's',
  smtpPort: 465,
};
const ADS = 'List-Unsubscribe: <https://news.example/u>\r\nPrecedence: bulk\r\n';

function setup(moveError: Error) {
  const dir = mkdtempSync(join(tmpdir(), 'mailmoveerr-'));
  const imap: ImapMover = {
    connect: async () => {},
    mailboxOpen: async () => ({ uidValidity: 7n }),
    search: async () => [1],
    fetchOne: async (uid) => ({
      uid: Number(uid),
      envelope: {
        from: [{ address: 'ofertas@news.example' }],
        subject: 'Rebajas',
        date: new Date(),
      },
      headers: Buffer.from(ADS),
    }),
    logout: async () => {},
    list: async () => [{ path: '[Gmail]/Todos', specialUse: '\\All' }],
    mailboxCreate: async () => {},
    messageMove: async () => {
      throw moveError;
    },
  };
  const tool = createMailRulesTool({
    account: async () => account,
    imap: () => imap,
    mover: () => imap,
    rulesFile: join(dir, 'rules.json'),
    batchFile: join(dir, 'batches.json'),
    now: () => 1_000_000_000_000,
  });
  return async (args: Record<string, unknown>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
}

async function cleanWith(err: Error) {
  const run = setup(err);
  const preview = await run({ action: 'limpiar_vista' });
  const lote = /lote ([0-9a-f]+)/.exec(preview)?.[1] ?? '';
  expect(lote).not.toBe('');
  return run({ action: 'limpiar', lote });
}

describe('limpiar correo: fallo al mover en castellano llano', () => {
  it('un error IMAP crudo no llega al chat', async () => {
    const raw = new Error(
      'Command failed: UID MOVE 1:3 "[Gmail]/Todos" NO [TRYCREATE] Mailbox doesn\'t exist (Failure) at /srv/imapflow/lib/x.js:12',
    );
    const text = await cleanWith(raw);
    expect(text).toMatch(/^No he movido nada: /);
    expect(text).not.toMatch(/UID MOVE|TRYCREATE|Failure|imapflow|\.js/);
  });

  it('contraseña rechazada y sin conexión dicen qué pasa', () => {
    const auth = Object.assign(new Error('Invalid credentials (Failure)'), {
      code: 'AUTHENTICATIONFAILED',
    });
    expect(mailMoveFailText(auth)).toContain('contraseña de aplicación');
    const net = Object.assign(new Error('connect ETIMEDOUT 142.250.1.1:993'), {
      code: 'ETIMEDOUT',
    });
    const t = mailMoveFailText(net);
    expect(t).toContain('no hay conexión');
    expect(t).not.toContain('142.250');
  });

  it('los avisos propios, ya claros, se dicen tal cual', () => {
    expect(
      mailMoveFailText(
        new Error('la bandeja ha cambiado desde la vista previa; vuelve a pedirme la lista'),
      ),
    ).toBe(
      'No he movido nada: la bandeja ha cambiado desde la vista previa; vuelve a pedirme la lista.',
    );
    expect(mailMoveFailText(new Error('no encuentro la papelera del correo'))).toBe(
      'No he movido nada: no encuentro la papelera del correo.',
    );
  });
});

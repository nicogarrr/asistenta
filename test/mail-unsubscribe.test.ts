import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import type { ImapLike } from '../src/mail/scan.js';
import { parseUnsubscribe, saveUnsubBatch } from '../src/mail/unsubscribe.js';
import { Gate } from '../src/permissions.js';
import { createMailRulesTool } from '../src/tools/mail-rules.js';

const account = {
  address: 'n@x.example',
  password: 'p',
  imapHost: 'h',
  imapPort: 993,
  smtpHost: 's',
  smtpPort: 465,
};
const ONE =
  'List-Unsubscribe: <https://a.example/u?t=1>, <mailto:u@a.example>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n';
const MAILTO = 'List-Unsubscribe: <mailto:baja@b.example?subject=baja>\r\n';
const LINK = 'List-Unsubscribe: <https://c.example/baja>\r\n';
const rows = [
  { from: 'news@a.example', h: ONE },
  { from: 'news@a.example', h: ONE },
  { from: 'info@b.example', h: MAILTO },
  { from: 'promo@c.example', h: LINK },
  { from: 'ana@amiga.example', h: '' },
];

function setup() {
  const posted: string[] = [];
  const imap: ImapLike = {
    connect: async () => {},
    mailboxOpen: async () => ({}),
    search: async () => rows.map((_, i) => i + 1),
    fetchOne: async (uid) => {
      const r = rows[Number(uid) - 1];
      const envelope = {
        from: [{ address: r?.from }],
        subject: 'x',
        date: new Date(Number(uid) * 1000),
      };
      return r && { uid: Number(uid), envelope, headers: Buffer.from(r.h) };
    },
    logout: async () => {},
  };
  const tool = createMailRulesTool({
    account: async () => account,
    imap: () => imap,
    rulesFile: join(mkdtempSync(join(tmpdir(), 'unsub-')), 'r.json'),
    post: async (url) => {
      posted.push(url);
      return 200;
    },
  });
  const run = async (args: Record<string, unknown>) =>
    ((await tool.execute('t', args as never)).content[0] as { text: string }).text;
  return { run, posted };
}

const loteOf = (text: string) => /lote ([0-9a-f]+)/.exec(text)?.[1] ?? '';

describe('darse de baja', () => {
  it('lee List-Unsubscribe: un clic solo con List-Unsubscribe-Post', () => {
    expect(
      parseUnsubscribe({
        'list-unsubscribe': '<https://a/u>',
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      }),
    ).toEqual({ metodo: 'un-clic', destino: 'https://a/u' });
    expect(parseUnsubscribe({ 'list-unsubscribe': '<https://a/u>, <mailto:x@a>' })).toEqual({
      metodo: 'correo',
      destino: 'x@a',
    });
    expect(parseUnsubscribe({ 'list-unsubscribe': '<https://a/u>' })?.metodo).toBe('enlace');
    expect(parseUnsubscribe({ 'list-unsubscribe': '<http://a/u>' })).toBeNull();
    expect(parseUnsubscribe({})).toBeNull();
  });

  it('la lista cuenta correos por remitente y no hace nada', async () => {
    const { run, posted } = setup();
    const text = await run({ action: 'baja_vista' });
    expect(text).toContain('1. news@a.example (2 correos): baja de un clic en a.example');
    expect(text).toContain('baja por correo a baja@b.example');
    expect(text).toContain('solo enlace');
    expect(text).not.toContain('amiga');
    expect(loteOf(text)).toBe('');
    expect(posted).toEqual([]);
  });

  it('solo actúa sobre el lote elegido, una vez, y lo apunta', async () => {
    const { run, posted } = setup();
    const view = await run({ action: 'baja_vista', numeros: [1, 2] });
    expect(view).not.toContain('c.example');
    const lote = loteOf(view);
    const done = await run({ action: 'baja', lote });
    expect(posted).toEqual(['https://a.example/u?t=1']);
    expect(done).toContain('news@a.example: hecho');
    expect(done).toContain('info@b.example: pendiente: correo de baja a baja@b.example');
    expect(await run({ action: 'baja', lote })).toContain('ya no vale');
    expect(posted).toHaveLength(1);
    const log = await run({ action: 'bajas' });
    expect(log).toContain('news@a.example (un-clic');
    expect(log).toContain('info@b.example (correo');
  });

  it('un enlace sin un clic nunca se visita', async () => {
    const { run, posted } = setup();
    const lote = loteOf(await run({ action: 'baja_vista', remitente: 'c.example' }));
    expect(await run({ action: 'baja', lote })).toContain('te paso el enlace');
    expect(posted).toEqual([]);
  });
});

describe('Gate y aprobación de la baja', () => {
  it('baja pregunta cada vez y enseña la lista exacta', async () => {
    const b = saveUnsubBatch(
      [
        {
          remitente: 'news@a.example',
          correos: 2,
          metodo: 'un-clic',
          destino: 'https://a.example/u',
        },
      ],
      Date.now(),
    );
    let asked = 0;
    const gate = new Gate({ approver: () => ++asked > 0 });
    const go = {
      tool: 'correo_reglas',
      args: { action: 'baja', lote: b.id },
      actor: 'local',
    } as const;
    await gate.check('s', go);
    gate.settle('s', go, true);
    await gate.check('s', go);
    expect(asked).toBe(2);
    const t = formatApproval(go, 'x');
    expect(t.question).toContain('news@a.example (2 correos): baja de un clic en a.example');
    expect(formatApproval({ ...go, args: { action: 'baja', lote: 'nope' } }, 'x').complete).toBe(
      false,
    );
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { saveBatch } from '../src/mail/cleanup.js';
import { CLEANUP_FOLDER, type ImapMover } from '../src/mail/move.js';
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
const ADS = 'List-Unsubscribe: <https://news.example/u>\r\nPrecedence: bulk\r\n';

type Row = { from: string; subject: string; headers?: string };

function fakeImap(rows: Row[]) {
  const calls: string[] = [];
  const imap: ImapMover = {
    connect: async () => {},
    mailboxOpen: async (_p, o) => calls.push(`open readOnly=${o.readOnly}`) && { uidValidity: 7n },
    search: async () => rows.map((_, i) => i + 1),
    fetchOne: async (uid) => {
      const r = rows[Number(uid) - 1];
      const envelope = { from: [{ address: r?.from }], subject: r?.subject, date: new Date() };
      return r && { uid: Number(uid), envelope, headers: Buffer.from(r.headers ?? '') };
    },
    logout: async () => {},
    list: async () => [{ path: '[Gmail]/Todos', specialUse: '\\All' }],
    mailboxCreate: async (p) => calls.push(`create ${p}`),
    messageMove: async (uids, dest) => calls.push(`move ${uids.join(',')} -> ${dest}`),
  };
  return { imap, calls };
}

const rows: Row[] = [
  { from: 'ofertas@news.example', subject: 'Rebajas de otoño', headers: ADS },
  { from: 'ana@amiga.example', subject: '¿Cenamos el sábado?' },
  { from: 'ofertas@news.example', subject: 'Solo hoy -50%', headers: ADS },
  { from: 'jobs@linkedin.example', subject: 'Nuevos empleos', headers: ADS },
];

function setup(r = rows) {
  const dir = mkdtempSync(join(tmpdir(), 'mailclean-'));
  const fake = fakeImap(r);
  const tool = createMailRulesTool({
    account: async () => account,
    imap: () => fake.imap,
    mover: () => fake.imap,
    rulesFile: join(dir, 'rules.json'),
    batchFile: join(dir, 'batches.json'),
    now: () => 1_000_000_000_000,
  });
  const run = async (args: Record<string, unknown>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  return { ...fake, run };
}

const loteOf = (text: string) => /lote ([0-9a-f]+)/.exec(text)?.[1] ?? '';

describe('limpiar correo: vista previa y lote aprobado', () => {
  it('la vista previa cuenta por remitente con ejemplos y no mueve nada', async () => {
    const { run, calls } = setup();
    const text = await run({ action: 'limpiar_vista' });
    expect(text).toContain('mover a Asistenta/Limpieza: 3 correos');
    expect(text).toContain('news.example: 2');
    expect(text).toContain('«Rebajas de otoño»');
    expect(text).not.toContain('Cenamos');
    expect(loteOf(text)).not.toBe('');
    expect(calls.some((c) => c.startsWith('move'))).toBe(false);
    expect(calls).toContain('open readOnly=true');
  });

  it('con el lote mueve exactamente esos correos, y el mismo lote no vale dos veces', async () => {
    const { run, calls } = setup();
    const lote = loteOf(await run({ action: 'limpiar_vista' }));
    const done = await run({ action: 'limpiar', lote });
    expect(done, done).toContain('Hecho: 3 correos');
    expect(calls).toContain(`create ${CLEANUP_FOLDER}`);
    expect(calls).toContain(`move 1,3,4 -> ${CLEANUP_FOLDER}`);
    const again = await run({ action: 'limpiar', lote });
    expect(again).toContain('ya no vale');
    expect(await run({ action: 'limpiar', lote: 'abcd1234' })).toContain('ya no vale');
    expect(calls.filter((c) => c.startsWith('move'))).toHaveLength(1);
  });

  it('por remitente, y papelera solo si se pide', async () => {
    const { run } = setup();
    const view = await run({ action: 'limpiar_vista', remitente: 'linkedin', destino: 'papelera' });
    expect(view).toContain('papelera (recuperable): 1 correo');
  });

  it('una regla guardada elige los correos y su acción', async () => {
    const { run, calls } = setup();
    await run({
      action: 'crear',
      texto: 'lo de LinkedIn archívalo',
      remitente: 'linkedin',
      accion: 'archivar',
    });
    const view = await run({ action: 'limpiar_vista', id: 1 });
    expect(view).toContain('archivar: 1 correo');
    await run({ action: 'limpiar', lote: loteOf(view) });
    expect(calls).toContain('move 4 -> [Gmail]/Todos');
  });
});

describe('Gate y aprobación de la limpieza', () => {
  it('limpiar pregunta cada vez, aunque se aprobara justo antes', async () => {
    let asked = 0;
    const gate = new Gate({
      approver: () => {
        asked += 1;
        return true;
      },
    });
    const b = saveBatch(
      { account: 'n@x.example', uidValidity: '7', uids: [1], accion: 'limpieza', resumen: 'x' },
      Date.now(),
    );
    const go = {
      tool: 'correo_reglas',
      args: { action: 'limpiar', lote: b.id },
      actor: 'local',
    } as const;
    const first = await gate.check('s', go);
    gate.settle('s', go, true);
    const second = await gate.check('s', go);
    expect([first.verdict, second.verdict, asked]).toEqual(['allow', 'allow', 2]);
  });

  it('la pregunta enseña el lote exacto guardado', () => {
    const b = saveBatch(
      {
        account: 'n@x.example',
        uidValidity: '7',
        uids: [1, 3],
        accion: 'limpieza',
        resumen: 'mover a Asistenta/Limpieza: 2 correos.\n• news.example: 2',
      },
      Date.now(),
    );
    const t = formatApproval(
      { tool: 'correo_reglas', args: { action: 'limpiar', lote: b.id }, actor: 'local' },
      'x',
    );
    expect(t.complete).toBe(true);
    expect(t.question).toContain('news.example: 2');
    expect(t.question).toContain(b.id);
    const gone = formatApproval(
      { tool: 'correo_reglas', args: { action: 'limpiar', lote: 'nope' }, actor: 'local' },
      'x',
    );
    expect(gone.complete).toBe(false);
  });
});

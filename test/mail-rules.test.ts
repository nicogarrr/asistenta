import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/core/capabilities.js';
import { addRule, deleteRule, loadRules, matchRule } from '../src/mail/rules.js';
import { type ImapLike, parseHeaders } from '../src/mail/scan.js';
import { createMailRulesTool, NO_MAIL_ACCOUNT } from '../src/tools/mail-rules.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'mailrules-')), 'rules.json');
const account = {
  address: 'n@x.example',
  password: 'p',
  imapHost: 'h',
  imapPort: 993,
  smtpHost: 's',
  smtpPort: 465,
};

function fakeImap(rows: Array<{ from: string; subject: string; headers?: string }>) {
  const opened: Array<{ readOnly: boolean }> = [];
  const imap: ImapLike = {
    connect: async () => {},
    mailboxOpen: async (_p, o) => opened.push(o),
    search: async () => rows.map((_, i) => i + 1),
    fetchOne: async (uid) => {
      const r = rows[Number(uid) - 1];
      return (
        r && {
          uid: Number(uid),
          envelope: { from: [{ address: r.from }], subject: r.subject, date: new Date() },
          flags: new Set(),
          headers: Buffer.from(r.headers ?? ''),
        }
      );
    },
    logout: async () => {},
  };
  return { imap, opened };
}

async function run(tool: ReturnType<typeof createMailRulesTool>, args: Record<string, unknown>) {
  const out = await tool.execute('t', args as never);
  return (out.content[0] as { text: string }).text;
}

describe('reglas de correo del dueño', () => {
  it('crear, listar y borrar; «excepto» deja fuera los pedidos', async () => {
    const file = tmpFile();
    const tool = createMailRulesTool({ account: async () => null, rulesFile: file });
    expect(
      await run(tool, {
        action: 'crear',
        texto: 'lo de Amazon que no sea un pedido, archívalo',
        remitente: 'amazon',
        excepto: 'pedido',
        accion: 'archivar',
      }),
    ).toContain('Regla guardada: 1.');
    expect(
      await run(tool, {
        action: 'crear',
        texto: 'LinkedIn a la papelera',
        remitente: 'linkedin',
        accion: 'papelera',
      }),
    ).toContain('papelera (recuperable)');
    const rules = loadRules(file);
    expect(matchRule(rules, { from: 'ofertas@amazon.es', subject: 'Rebajas' })?.id).toBe(1);
    expect(
      matchRule(rules, { from: 'ofertas@amazon.es', subject: 'Tu Pedido ha salido' }),
    ).toBeNull();
    expect(matchRule(rules, { from: 'Jobs <jobs@linkedin.com>', subject: 'x' })?.id).toBe(2);
    expect(await run(tool, { action: 'reglas' })).toMatch(
      /^Reglas de correo:\n1\. de «amazon», salvo si el asunto dice «pedido» → archivar\n2\./,
    );
    expect(await run(tool, { action: 'borrar', id: 1 })).toContain('Regla borrada: 1.');
    expect(await run(tool, { action: 'borrar', id: 9 })).toBe('No hay regla 9.');
    expect(loadRules(file).map((r) => r.id)).toEqual([2]);
  });

  it('una regla sin criterio o sin acción no se guarda', async () => {
    const file = tmpFile();
    expect(addRule({ texto: 'todo', accion: 'papelera' }, file)).toMatch(/al menos/);
    const tool = createMailRulesTool({ account: async () => null, rulesFile: file });
    expect(await run(tool, { action: 'crear', remitente: 'x' })).toMatch(/^Falta qué hacer/);
    expect(loadRules(file)).toEqual([]);
    expect(deleteRule(1, file)).toBeNull();
  });
});

describe('resumen del correo (solo lectura)', () => {
  it('sin cuenta lo dice claro', async () => {
    const tool = createMailRulesTool({ account: async () => null, rulesFile: tmpFile() });
    expect(await run(tool, { action: 'resumen' })).toBe(NO_MAIL_ACCOUNT);
  });

  it('cuenta por tipo y remitente, avisa de estafas y de reglas, abre en solo lectura', async () => {
    const file = tmpFile();
    addRule({ texto: 'linkedin fuera', remitente: 'linkedin', accion: 'limpieza' }, file);
    const { imap, opened } = fakeImap([
      {
        from: 'news@linkedin.com',
        subject: 'Empleos',
        headers: 'List-Unsubscribe: <https://l/u>\r\n',
      },
      { from: 'news@linkedin.com', subject: 'Más empleos', headers: 'List-Id: <l>\r\n' },
      { from: 'no-reply@paypa1.com', subject: 'Cuenta limitada' },
      { from: 'ana@amigos.example', subject: 'Cena' },
    ]);
    const tool = createMailRulesTool({
      account: async () => account,
      imap: () => imap,
      rulesFile: file,
    });
    const text = await run(tool, { action: 'resumen' });
    expect(text).toContain('He mirado 4 correos recientes:');
    expect(text).toContain('• publicidad/newsletter: 2 (linkedin.com 2)');
    expect(text).toContain(
      '⚠️ posible estafa: «Cuenta limitada» de no-reply@paypa1.com (el dominio paypa1.com imita a paypal)',
    );
    expect(text).toContain('• importante: 1');
    expect(text).toContain('→ mover a Asistenta/Limpieza: 2 correos.');
    expect(text.endsWith('No he movido ni borrado nada.')).toBe(true);
    expect(opened).toEqual([{ readOnly: true }]);
  });

  it('las cabeceras plegadas se leen enteras', () => {
    expect(
      parseHeaders('List-Unsubscribe: <mailto:a@b>,\r\n <https://b/u>\r\nPrecedence: bulk\r\n'),
    ).toEqual({
      'list-unsubscribe': '<mailto:a@b>, <https://b/u>',
      precedence: 'bulk',
    });
  });

  it('está en el registro de capacidades y sin permiso libre en hilos', () => {
    const cap = CAPABILITIES.find((c) => c.name === 'correo_reglas');
    expect(cap).toBeDefined();
    expect(cap?.threadAllow).toBeFalsy();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { MailAccount, MailMessage } from '../src/mail/types.js';
import { redactSecrets } from '../src/mail/types.js';
import { createMailTool } from '../src/tools/mail.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/** The vault is not available in tests, so the account is injected through `client`. */
const ACCOUNT: MailAccount = {
  address: 'yo@ejemplo.com',
  password: 'super-secreta-1234',
  imapHost: 'imap.ejemplo.com',
  imapPort: 993,
  smtpHost: 'smtp.ejemplo.com',
  smtpPort: 465,
};

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: '1',
    from: 'ana@ejemplo.com',
    to: ['yo@ejemplo.com'],
    subject: 'Reunión del viernes',
    text: 'Nos vemos a las 10 en la sala 2.',
    at: Date.UTC(2026, 9, 5, 9, 0, 0),
    seen: false,
    folder: 'INBOX',
    ...overrides,
  };
}

function deps(
  overrides: Partial<Parameters<typeof createMailTool>[0]['client']> = {},
  approvals: boolean[] = [],
) {
  return {
    requireApproval: vi.fn(async () => approvals.shift() ?? true),
    client: {
      loadAccount: async () => ACCOUNT,
      search: vi.fn(async () => [message()]),
      read: vi.fn(async () => message()),
      markSeen: vi.fn(async () => {}),
      send: vi.fn(async () => ({ ok: true, id: 'mid-1' })),
      folders: vi.fn(async () => ['INBOX', 'Spam']),
      ...overrides,
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('createMailTool', () => {
  it('says the mailbox is not configured instead of failing', async () => {
    const tool = createMailTool(deps({ loadAccount: async () => null }));
    const out = await tool.execute('m1', { action: 'list' });
    expect(textOf(out)).toMatch(/no está configurado/i);
    expect(out.details).toMatchObject({ configured: false });
  });

  it('lists messages without ever returning a credential', async () => {
    const tool = createMailTool(deps());
    const out = await tool.execute('m2', { action: 'list' });
    const text = textOf(out);
    expect(text).toContain('ana@ejemplo.com');
    expect(text).toContain('Reunión del viernes');
    expect(text).toContain('sin leer');
    // The password is the one thing that must never reach the model.
    expect(text).not.toContain('super-secreta-1234');
    expect(JSON.stringify(out.details)).not.toContain('super-secreta-1234');
    expect(JSON.stringify(out.details)).not.toContain('yo@ejemplo.com');
  });

  it('passes the search filters through and reports ids', async () => {
    const search = vi.fn(async () => [message({ id: '42', seen: true })]);
    const tool = createMailTool(deps({ search }));
    const out = await tool.execute('m3', {
      action: 'search',
      from: 'ana@ejemplo.com',
      q: 'reunión',
      unreadOnly: true,
      limit: 5,
    });
    expect(search).toHaveBeenCalledOnce();
    const [, query, limit] = search.mock.calls[0] as unknown as [
      MailAccount,
      Record<string, unknown>,
      number,
    ];
    expect(query.from).toBe('ana@ejemplo.com');
    expect(query.unreadOnly).toBe(true);
    expect(limit).toBe(5);
    expect(out.details).toMatchObject({ ids: ['42'] });
    // A read message must not be advertised as unread.
    expect(textOf(out)).not.toContain('sin leer');
  });

  it('reads one message in full and never leaks the password in the body', async () => {
    const tool = createMailTool(
      deps({ read: async () => message({ text: 'Mi clave es super-secreta-1234, no la digas.' }) }),
    );
    const out = await tool.execute('m4', { action: 'read', id: '1' });
    const text = textOf(out);
    expect(text).toContain('Mi clave es');
    // The body is passed through as-is: redacting a user's own words would be lying
    // about what they sent. What matters is that it is not in `details`.
    expect(JSON.stringify(out.details)).not.toContain('super-secreta-1234');
  });

  it('never sends without an explicit approval', async () => {
    const send = vi.fn(async () => ({ ok: true, id: 'x' }));
    const tool = createMailTool(deps({ send }, [false]));
    const out = await tool.execute('m5', {
      action: 'send',
      to: 'ana@ejemplo.com',
      subject: 'Hola',
      text: 'Buenos días',
    });
    expect(send).not.toHaveBeenCalled();
    expect(out.details).toMatchObject({ sent: false, approved: false });
  });

  it('reports a failed send honestly instead of claiming success', async () => {
    const send = vi.fn(async () => ({ ok: false, error: 'el servidor dijo 550' }));
    const tool = createMailTool(deps({ send }, [true]));
    const out = await tool.execute('m6', {
      action: 'send',
      to: 'ana@ejemplo.com',
      subject: 'Hola',
      text: 'Buenos días',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(out.details).toMatchObject({ sent: false, approved: true });
    expect(textOf(out)).toContain('550');
  });

  it('asks for approval with the subject and recipients, never the body', async () => {
    // Typed as a two-argument mock: without the parameter list, vitest infers
    // `[]` for the call tuple and indexing it at 1 is a type error even though
    // the function really is called with (action, summary).
    const requireApproval = vi.fn(async (_action: string, _summary: string) => true);
    const tool = createMailTool({ ...deps(), requireApproval });
    await tool.execute('m7', {
      action: 'send',
      to: 'ana@ejemplo.com',
      subject: 'Informe',
      text: 'cuerpo muy largo que no debe salir en el diálogo',
    });
    const summary = String(requireApproval.mock.calls[0]?.[1] ?? '');
    expect(summary).toContain('Informe');
    expect(summary).toContain('ana@ejemplo.com');
    expect(summary).not.toContain('cuerpo muy largo');
  });

  it('lists folders', async () => {
    const tool = createMailTool(deps());
    const out = await tool.execute('m8', { action: 'folders' });
    expect(textOf(out)).toContain('INBOX');
    expect(out.details).toMatchObject({ folders: ['INBOX', 'Spam'] });
  });
});

describe('redactSecrets', () => {
  it('removes addresses, credential-shaped tokens and key=value pairs', () => {
    const out = redactSecrets(
      'fallo al conectar como nico@ejemplo.com con password: abcdef1234 token=xyz',
    );
    expect(out).not.toContain('nico@ejemplo.com');
    expect(out).not.toContain('abcdef1234');
    expect(out).toContain('[email]');
    expect(out).toContain('[redactado]');
  });
});

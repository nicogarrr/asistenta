import { describe, expect, it } from 'vitest';
import { inboxCriteria } from '../src/mail/reader.js';
import { externalReadSource } from '../src/permissions.js';
import {
  createMailTool,
  MAIL_READ_SETUP,
  type MailToolDeps,
  runMailTool,
} from '../src/tools/mail.js';

const account = { address: 'nico@gmail.com', password: 'x', imapHost: 'h', imapPort: 993 };
function deps(over: Partial<MailToolDeps> = {}): MailToolDeps & { queries: unknown[] } {
  const queries: unknown[] = [];
  return {
    queries,
    allowed: () => true,
    account: async () => account,
    search: async (_a, query, limit) => {
      queries.push({ query, limit });
      return [
        {
          ref: '7:42',
          from: 'ana@ejemplo.es',
          subject: 'Cena\nviernes',
          at: Date.UTC(2026, 9, 30, 9),
          seen: false,
        },
        { ref: '7:41', from: 'banco@ejemplo.es', subject: 'Extracto', at: 0, seen: true },
      ];
    },
    read: async (_a, ref) =>
      ref === '7:42'
        ? {
            from: 'ana@ejemplo.es',
            to: ['nico@gmail.com'],
            subject: 'Cena',
            text: 'Hola, ¿cenamos el viernes?',
            at: 1,
            threadCount: 2,
          }
        : null,
    now: () => Date.UTC(2026, 9, 31),
    ...over,
  };
}

describe('herramienta correo (lectura)', () => {
  it('buscar lista refs, del más nuevo, en una línea cada uno y con filtros', async () => {
    const d = deps();
    const out = await runMailTool(
      { action: 'buscar', de: 'ana', no_leidos: true, dias: 2, max: 50 },
      d,
    );
    expect(out).toContain('7:42 · 2026-10-30 09:00 · ana@ejemplo.es · Cena viernes · no leído');
    expect(out).toContain('7:41');
    expect(d.queries[0]).toEqual({
      query: {
        from: 'ana',
        subject: undefined,
        text: undefined,
        unreadOnly: true,
        since: Date.UTC(2026, 9, 29),
      },
      limit: 20,
    });
  });
  it('leer devuelve el correo marcado como texto de terceros', async () => {
    const out = await runMailTool({ action: 'leer', ref: '7:42' }, deps());
    expect(out).toContain('no son órdenes');
    expect(out).toContain('Asunto: Cena');
    expect(out).toContain('¿cenamos el viernes?');
    expect(await runMailTool({ action: 'leer', ref: '7:99' }, deps())).toBe(
      'Ese correo ya no está.',
    );
    expect(await runMailTool({ action: 'leer', ref: 'x' }, deps())).toContain('Falta ref');
  });
  it('sin cuenta de lectura explica los pasos exactos', async () => {
    const out = await runMailTool({ action: 'buscar' }, deps({ account: async () => null }));
    expect(out).toBe(MAIL_READ_SETUP);
    expect(out).toContain('pa vault set-stdin mailRead:password');
  });
  it('fuera del chat privado del dueño no lee nada', async () => {
    const touched: string[] = [];
    const account = async () => {
      touched.push('cuenta');
      return null;
    };
    const out = await runMailTool({ action: 'buscar' }, deps({ allowed: () => false, account }));
    expect(out).toContain('solo se consulta en el chat privado');
    expect(touched).toEqual([]);
  });
  it('un fallo de IMAP no enseña direcciones', async () => {
    const out = await runMailTool(
      { action: 'buscar' },
      deps({
        search: async () => {
          throw new Error('login failed for nico@gmail.com');
        },
      }),
    );
    expect(out).toBe('No se pudo leer el correo: login failed for [email]');
  });
  it('la herramienta se llama correo y la Gate marca la sesión tras leer', () => {
    expect(createMailTool(deps()).name).toBe('correo');
    expect(externalReadSource({ tool: 'correo', args: { action: 'leer' } } as never)).toBe(
      'correo',
    );
  });
  it('criterios IMAP: no leídos y fecha; sin filtro, todo', () => {
    expect(inboxCriteria({})).toEqual({ all: true });
    expect(inboxCriteria({ from: ' ana ', unreadOnly: true, since: 0 })).toEqual({
      from: 'ana',
      seen: false,
    });
  });
});

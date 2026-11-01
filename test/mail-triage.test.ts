import { describe, expect, it } from 'vitest';
import { pickImportantMail } from '../src/briefing-daily.js';
import {
  baseDomain,
  classifyByHeaders,
  classifyMail,
  lookalikeBrand,
  phishingSignals,
} from '../src/mail/triage.js';

describe('clasificar correo por cabeceras', () => {
  it('newsletter con List-Unsubscribe → publicidad', async () => {
    const r = await classifyMail({
      from: 'Ofertas <ofertas@tienda.example>',
      subject: '¡Rebajas del 50%!',
      headers: { 'list-unsubscribe': '<https://tienda.example/baja>' },
    });
    expect(r.category).toBe('publicidad');
    expect(r.source).toBe('cabeceras');
  });

  it('un pedido de una lista con baja → notificación, no publicidad', () => {
    const r = classifyByHeaders({
      from: 'pedidos@amazon.es',
      subject: 'Tu pedido ha sido enviado',
      headers: { 'list-id': '<pedidos.amazon.es>' },
    });
    expect(r?.category).toBe('notificacion');
  });

  it('Precedence: bulk cuenta como envío masivo', () => {
    const r = classifyByHeaders({
      from: 'x@club.example',
      subject: 'Novedades',
      headers: { precedence: 'bulk' },
    });
    expect(r?.category).toBe('publicidad');
  });

  it('no-reply y Auto-Submitted → notificación', () => {
    expect(classifyByHeaders({ from: 'no-reply@banco.example', subject: 'Hola' })?.category).toBe(
      'notificacion',
    );
    expect(
      classifyByHeaders({
        from: 'ana@x.example',
        subject: 'Fuera',
        headers: { 'auto-submitted': 'auto-replied' },
      })?.category,
    ).toBe('notificacion');
  });

  it('alguien a quien le has escrito → personal', () => {
    const r = classifyByHeaders(
      { from: 'Ana <ANA@amigos.example>', subject: 'Cena' },
      { contacts: ['ana@amigos.example'] },
    );
    expect(r).toEqual({
      category: 'personal',
      source: 'historial',
      reasons: ['le has escrito antes'],
    });
  });

  it('desconocido sin señales: sin modelo queda importante (nunca entra en limpieza)', async () => {
    const r = await classifyMail({ from: 'jefe@empresa.example', subject: 'Reunión mañana' });
    expect(r).toMatchObject({ category: 'importante', source: 'por defecto' });
  });

  it('solo pregunta al modelo cuando las cabeceras no deciden, y con poco texto', async () => {
    const calls: Array<{ snippet: string }> = [];
    const model = async (i: { snippet: string }) => {
      calls.push(i);
      return 'publicidad' as const;
    };
    const decided = await classifyMail(
      { from: 'x@y.example', subject: 'a', headers: { 'list-id': 'l' } },
      {},
      model,
    );
    expect(decided.source).toBe('cabeceras');
    expect(calls).toHaveLength(0);
    const r = await classifyMail(
      { from: 'x@y.example', subject: 'Oferta', text: 'z'.repeat(5000) },
      {},
      model,
    );
    expect(r).toMatchObject({ category: 'publicidad', source: 'modelo' });
    expect(calls[0]?.snippet.length).toBeLessThanOrEqual(300);
  });

  it('un modelo que falla o inventa categoría no cambia el «importante»', async () => {
    const boom = async () => {
      throw new Error('x');
    };
    expect((await classifyMail({ from: 'a@b.example', subject: 's' }, {}, boom)).category).toBe(
      'importante',
    );
    const weird = async () => 'borrar' as never;
    expect((await classifyMail({ from: 'a@b.example', subject: 's' }, {}, weird)).category).toBe(
      'importante',
    );
  });
});

describe('spam sospechoso (phishing)', () => {
  it('dominios que imitan marcas', () => {
    expect(lookalikeBrand('paypa1.com')).toBe('paypal');
    expect(lookalikeBrand('arnazon.es')).toBe('amazon');
    expect(lookalikeBrand('amazon-seguridad.info')).toBe('amazon');
    expect(lookalikeBrand('paypal.xyz')).toBe('paypal');
    expect(lookalikeBrand('email.amazon.es')).toBeNull();
    expect(lookalikeBrand('paypal.com')).toBeNull();
    expect(lookalikeBrand('ingenieria.com')).toBeNull();
    expect(lookalikeBrand('gmail.com')).toBeNull();
    expect(baseDomain('news.amazon.co.uk')).toBe('amazon.co.uk');
  });

  it('imitar una marca basta para marcarlo spam', () => {
    const r = classifyByHeaders({ from: 'servicio@paypa1.com', subject: 'Aviso' });
    expect(r?.category).toBe('spam');
    expect(r?.reasons[0]).toContain('imita a paypal');
  });

  it('Reply-To a otro dominio + pago urgente → spam; una sola señal no', () => {
    const scam = {
      from: 'facturas@proveedor.example',
      replyTo: ['cobros@otro-sitio.example'],
      subject: 'URGENTE: factura pendiente',
      text: 'Pague en 24 horas por transferencia o se suspende el servicio.',
    };
    expect(phishingSignals(scam)).toHaveLength(2);
    expect(classifyByHeaders(scam)?.category).toBe('spam');
    expect(classifyByHeaders({ ...scam, subject: 'Factura', text: 'Adjunta.' })?.category).not.toBe(
      'spam',
    );
  });

  it('nombre de marca con remitente ajeno y SPF fallido', () => {
    const s = phishingSignals({
      from: 'Netflix <soporte@cuenta-gratis.example>',
      subject: 'Tu cuenta',
      headers: { 'authentication-results': 'mx.google.com; spf=fail smtp.mailfrom=x' },
    });
    expect(s.some((x) => x.includes('dice ser netflix'))).toBe(true);
    expect(s).toContain('no pasa la verificación del remitente');
  });

  it('un correo normal de una marca de verdad no da señales', () => {
    expect(
      phishingSignals({
        from: 'Amazon.es <confirmar-envio@amazon.es>',
        replyTo: ['no-reply@amazon.es'],
        subject: 'Tu pedido',
      }),
    ).toEqual([]);
  });
});

describe('resumen matutino: avisa de correos que huelen a estafa', () => {
  const now = Date.UTC(2026, 9, 31, 7, 0);
  it('el sospechoso sale primero con aviso, aunque venga de un no-reply', () => {
    const out = pickImportantMail(
      [
        { from: 'ana@amigos.example', subject: 'Cena', at: now - 3_600_000, seen: false },
        {
          from: 'no-reply@paypa1.com',
          subject: 'Cuenta limitada',
          at: now - 7_200_000,
          seen: false,
        },
        { from: 'news@tienda.example', subject: 'Rebajas', at: now - 60_000, seen: false },
      ],
      now,
    );
    expect(out[0]?.subject).toMatch(
      /^⚠️ posible estafa \(el dominio paypa1\.com imita a paypal\): Cuenta limitada$/,
    );
    expect(out.map((m) => m.subject)).toContain('Cena');
    expect(out).toHaveLength(2);
  });

  it('pago urgente con el cuerpo: lo marca; un correo normal no', () => {
    const out = pickImportantMail(
      [
        {
          from: 'Netflix <cobros@pagos-netflix.example>',
          subject: 'Último aviso',
          text: 'Actualiza tu tarjeta en 24 horas o se suspende.',
          at: now - 60_000,
          seen: false,
        },
        {
          from: 'jefe@empresa.example',
          subject: 'Informe',
          text: 'Adjunto.',
          at: now - 120_000,
          seen: false,
        },
      ],
      now,
    );
    expect(out[0]?.subject.startsWith('⚠️ posible estafa')).toBe(true);
    expect(out[1]).toEqual({ from: expect.any(String), subject: 'Informe' });
  });
});

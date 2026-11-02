import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import { PersonalAgent } from '../src/core/agent.js';
import { SUMMARY_MARKER, SUMMARY_WARNING } from '../src/core/history.js';
import type { Gate } from '../src/permissions.js';
import {
  contextoDeHilo,
  type HiloDaemon,
  MAX_HILOS,
  panelContexto,
  panelContextoDeHilos,
} from '../src/webui/contexto.js';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const SECRETO = 'sk-SECRETO-NO-DEBE-SALIR-1234567890';

function msg(role: string, text: string, extra: Record<string, unknown> = {}) {
  return { role, content: [{ type: 'text', text }], timestamp: 1, ...extra } as never;
}

function fuente(over: Partial<Parameters<typeof contextoDeHilo>[0]> = {}) {
  return {
    titulo: 'principal',
    activo: false,
    modelo: 'modelo-falso',
    tools: [
      { name: 'recordar', description: `guarda ${SECRETO}`, parameters: { type: 'object' } },
      { name: 'buscar_web', description: 'busca', parameters: {} },
    ],
    messages: [
      {
        role: 'system',
        content: `${'x'.repeat(396)}${SECRETO.slice(0, 4)}`,
        toolsAdded: [{ name: 'recordar' }],
        timestamp: 0,
      } as never,
      { role: 'system', content: `<memory>${SECRETO}</memory> Ahora: 10:00` } as never,
      msg('user', `${SUMMARY_MARKER}\n${SUMMARY_WARNING}\nresumen`, {
        timestamp: Date.UTC(2026, 10, 2, 9, 30),
      }),
      msg('user', `hola ${SECRETO}`),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'mira' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        timestamp: 2,
      } as never,
      msg('assistant', 'vale'),
    ],
    ventana: 100_000,
    umbralResumen: 60_000,
    resumenes: 1,
    ...over,
  };
}

describe('panel Contexto: desglose de un hilo (solo números y nombres)', () => {
  it('reparte instrucciones, herramientas, notas, resumen y conversación con la misma estimación', () => {
    const h = contextoDeHilo(fuente());
    expect(h.partes.map((p) => p.id)).toEqual([
      'instrucciones',
      'herramientas',
      'adjuntos',
      'resumen',
      'conversacion',
    ]);
    const por = Object.fromEntries(h.partes.map((p) => [p.id, p.tokens])) as Record<string, number>;
    expect(por.instrucciones).toBe(100);
    expect(por.herramientas).toBeGreaterThan(0);
    expect(por.adjuntos).toBeGreaterThan(0);
    expect(por.resumen).toBeGreaterThan(0);
    // La imagen cuenta 1.500 como en el resumen automático.
    expect(por.conversacion).toBeGreaterThanOrEqual(1500);
    expect(h.total).toBe(Object.values(por).reduce((a, b) => a + b, 0));
    expect(h.historial).toBe(h.total - (por.herramientas ?? 0));
    expect(h.faltanParaResumen).toBe(60_000 - h.historial);
    expect(h.porcentaje).toBe(Math.round((h.total / 100_000) * 100));
    expect(h.ultimoResumen).toBe('2026-11-02T09:30:00.000Z');
    expect(h.herramientas).toEqual(['recordar', 'buscar_web']);
    expect(h.estado).toBe('en espera');
    expect(h.partes.find((p) => p.id === 'conversacion')?.detalle).toBe('3 mensajes · 1 imagen');
  });

  it('nunca devuelve el texto de las instrucciones, mensajes, notas ni descripciones', () => {
    const json = JSON.stringify(panelContexto([fuente()]));
    expect(json).not.toContain('SECRETO');
    expect(json).not.toContain('xxxx');
    expect(json).not.toContain('hola');
    expect(json).not.toContain('<memory>');
  });

  it('sin resumen todavía y con el resumen apagado lo dice', () => {
    const h = contextoDeHilo(fuente({ messages: [msg('user', 'hola')], umbralResumen: 0 }));
    expect(h.ultimoResumen).toBeNull();
    expect(h.resumenApagado).toBe(true);
    expect(h.faltanParaResumen).toBeNull();
  });

  it('pasado el umbral, faltan 0 (no negativo)', () => {
    const h = contextoDeHilo(fuente({ umbralResumen: 10 }));
    expect(h.faltanParaResumen).toBe(0);
  });

  it('respondiendo primero, luego los que más ocupan, con tope de hilos', () => {
    const muchos = Array.from({ length: MAX_HILOS + 3 }, (_, i) =>
      fuente({ titulo: `h${i}`, messages: [msg('user', 'y'.repeat(i * 40))] }),
    );
    muchos.push(fuente({ titulo: 'activo', activo: true, messages: [] }));
    const r = panelContexto(muchos);
    expect(r.hilos).toHaveLength(MAX_HILOS);
    expect(r.hilos[0]?.titulo).toBe('activo');
    expect(r.hilos[0]?.estado).toBe('respondiendo');
    expect(r.otros).toBe(4);
    expect(r.aprox).toBe(true);
    expect(r.nota).toMatch(/aprox\./);
  });
});

function hiloFalso(chatKey: string, label: string): HiloDaemon {
  return {
    chatKey,
    name: 'main',
    label,
    active: false,
    agent: {
      modelId: 'm',
      compaction: { triggerTokens: 50_000 },
      compactions: 0,
      agent: { state: { tools: [], messages: [{ role: 'system', content: 'abc' } as never] } },
    },
  };
}

describe('panel Contexto: desde los hilos del daemon', () => {
  const prevCompact = process.env.PA_COMPACT_TOKENS;
  afterEach(() => {
    if (prevCompact === undefined) delete process.env.PA_COMPACT_TOKENS;
    else process.env.PA_COMPACT_TOKENS = prevCompact;
  });

  it('con dueño solo detalla sus hilos privados; los demás se cuentan sin nombre', () => {
    const r = panelContextoDeHilos(
      [hiloFalso('telegram:dm:7', 'principal'), hiloFalso('telegram:group:-5', 'grupo secreto')],
      7,
      1_000_000,
      {},
    );
    expect(r.hilos.map((h) => h.titulo)).toEqual(['principal']);
    expect(r.otros).toBe(1);
    expect(r.hilos[0]?.ventana).toBe(1_000_000);
    expect(JSON.stringify(r)).not.toMatch(/grupo secreto|telegram/);
  });

  it('PA_COMPACT_TOKENS=0 = resumen apagado', () => {
    const r = panelContextoDeHilos([hiloFalso('local', 'x')], undefined, 1000, {
      PA_COMPACT_TOKENS: '0',
    });
    expect(r.hilos[0]?.resumenApagado).toBe(true);
    const on = panelContextoDeHilos([hiloFalso('local', 'x')], undefined, 1000, {});
    expect(on.hilos[0]?.umbralResumen).toBe(50_000);
  });
});

describe('panel Contexto: con un agente de verdad (sin red)', () => {
  const gate: Gate = { check: async () => ({ verdict: 'allow' }) } as unknown as Gate;
  const prev = process.env.OPENCODE_GO_API_KEY;
  beforeEach(() => {
    process.env.OPENCODE_GO_API_KEY = 'test-key-no-network';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCODE_GO_API_KEY;
    else process.env.OPENCODE_GO_API_KEY = prev;
  });

  it('lee instrucciones, herramientas y la nota de contexto del agente', async () => {
    resetConfigForTests();
    const agent = await PersonalAgent.create(loadConfig(), [], gate, 'test');
    agent.agent.state.messages = [...agent.agent.state.messages, msg('user', 'hola')];
    agent.attachContext(`<memory>${SECRETO}</memory>`);
    const r = panelContextoDeHilos(
      [{ chatKey: 'local', name: 'main', label: 'principal', active: false, agent }],
      undefined,
      1_048_576,
      {},
    );
    const h = r.hilos[0];
    expect(h).toBeDefined();
    const por = Object.fromEntries((h?.partes ?? []).map((p) => [p.id, p.tokens])) as Record<
      string,
      number
    >;
    expect(por.instrucciones).toBeGreaterThan(100);
    expect(por.adjuntos).toBeGreaterThan(0);
    expect(h?.umbralResumen).toBe(agent.compaction.triggerTokens);
    expect(JSON.stringify(r)).not.toContain('SECRETO');
  });
});

describe('panel Contexto: ruta y tarjeta', () => {
  const base: WebUiDeps = {
    token: 'test-only',
    status: () => ({}),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({}),
  };
  const headers = { Authorization: 'Bearer test-only' };

  it('GET /api/contexto pide token, 503 sin datos, solo GET, y devuelve la forma esperada', async () => {
    const sin = await startWebUi(base);
    try {
      expect((await fetch(`${sin.url}/api/contexto`, { headers })).status).toBe(503);
    } finally {
      await sin.close();
    }
    const ui = await startWebUi({ ...base, contexto: () => panelContexto([fuente()]) });
    try {
      expect((await fetch(`${ui.url}/api/contexto`)).status).toBe(401);
      expect(
        (await fetch(`${ui.url}/api/contexto`, { headers: { Authorization: 'Bearer otro' } }))
          .status,
      ).toBe(401);
      expect((await fetch(`${ui.url}/api/contexto`, { method: 'POST', headers })).status).toBe(405);
      const ok = await fetch(`${ui.url}/api/contexto`, { headers });
      expect(ok.status).toBe(200);
      const datos = (await ok.json()) as ReturnType<typeof panelContexto>;
      expect(datos.aprox).toBe(true);
      expect(datos.hilos[0]).toMatchObject({
        titulo: 'principal',
        ventana: 100_000,
        umbralResumen: 60_000,
        resumenes: 1,
      });
      expect(JSON.stringify(datos)).not.toContain('SECRETO');
    } finally {
      await ui.close();
    }
  });

  it('el panel tiene la tarjeta Contexto y la carga con el resto', () => {
    const html = renderPage();
    expect(html).toContain('<h2 id="titulo-contexto">Contexto</h2>');
    expect(html).toContain('id="panel-contexto"');
    expect(html).toContain("pedir('/api/contexto')");
    expect(html).toContain('contexto: cargarContexto');
    expect(html).toContain('cargarContexto(),');
    expect(html).toContain('aprox.');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});

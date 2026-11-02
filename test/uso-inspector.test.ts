import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Inspector /uso: composición del contexto por turno y cuota OpenCode Go.
 * paths.ts congela PA_STATE_DIR al importarse: tmp antes del import dinámico
 * (mismo patrón que usage.test.ts).
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-uso-'));
process.env.PA_STATE_DIR = stateDir;
delete process.env.PA_PRICE_INPUT_PER_MTOK;
delete process.env.PA_PRICE_OUTPUT_PER_MTOK;

const usage = await import('../src/core/usage.js');
const { contextComposition } = await import('../src/core/history.js');
const { formatContextAvg, formatGoQuota, formatUsageReport } = await import(
  '../src/core/usage-format.js'
);
const { fetchGoQuota, parseGoQuota, resetGoQuotaCache } = await import('../src/core/go-quota.js');

afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

describe('contextComposition (estimación pura)', () => {
  const msg = (text: string) => ({ role: 'user', content: text }) as never;

  it('reparte sistema, notas de memoria, historial y herramientas', () => {
    const note = msg('n'.repeat(400));
    const c = contextComposition(
      [msg('h'.repeat(800)), note, msg('h'.repeat(400))],
      (m) => m === note,
      's'.repeat(200),
      [{ name: 'a'.repeat(96) }],
    );
    expect(c.system).toBe(50);
    expect(c.memory).toBe(100);
    expect(c.history).toBe(300);
    expect(c.tools).toBeGreaterThan(0);
  });

  it('sin notas todo el mensaje es historial; herramientas no serializables no rompen', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const c = contextComposition([msg('abcd')], () => false, '', [circular]);
    expect(c.history).toBe(1);
    expect(c.memory).toBe(0);
    expect(c.tools).toBe(0);
  });
});

describe('usage: contexto estimado en el libro diario', () => {
  it('recordUsage guarda la composición y usageReport la promedia', () => {
    usage.recordUsage({
      sessionId: 'insp',
      model: 'm',
      inputTokens: 100,
      outputTokens: 10,
      kind: 'turn',
      context: { system: 1000, memory: 200, history: 5000, tools: 800 },
    });
    usage.recordUsage({
      sessionId: 'insp',
      model: 'm',
      inputTokens: 100,
      outputTokens: 10,
      kind: 'turn',
      context: { system: 1200, memory: 400, history: 7000, tools: 1000 },
    });
    // Turno viejo sin contexto: cuenta en tokens pero no en la media.
    usage.recordUsage({
      sessionId: 'insp',
      model: 'm',
      inputTokens: 5,
      outputTokens: 5,
      kind: 'turn',
    });
    const report = usage.usageReport(1);
    expect(report.contextAvg).toEqual({
      system: 1100,
      memory: 300,
      history: 6000,
      tools: 900,
      turns: 2,
    });
  });

  it('contexto basura no se guarda', () => {
    const rec = usage.recordUsage({
      sessionId: 'insp2',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      kind: 'turn',
      context: { system: -5, memory: Number.NaN, history: 0, tools: 0 } as never,
    });
    expect(rec.context).toBeUndefined();
  });
});

describe('formato del inspector', () => {
  it('formatContextAvg etiqueta la estimación y da las cuatro partes', () => {
    const text = formatContextAvg({
      system: 1234,
      memory: 56,
      history: 7890,
      tools: 100,
      turns: 3,
    });
    expect(text).toContain('estimado');
    expect(text).toContain('sistema 1.234');
    expect(text).toContain('memoria 56');
    expect(text).toContain('historial 7.890');
    expect(text).toContain('herramientas 100');
    expect(text).toContain('3 turnos');
  });

  it('formatGoQuota lista las ventanas presentes; vacía -> null', () => {
    expect(
      formatGoQuota({
        rolling: { status: 'ok', percent: 2 },
        weekly: { status: 'ok', percent: 9 },
        monthly: { status: 'ok', percent: 64 },
      }),
    ).toBe('Cuota OpenCode Go: horas 2 % · semana 9 % · mes 64 %');
    expect(formatGoQuota({ monthly: { status: 'ok', percent: 64 } })).toBe(
      'Cuota OpenCode Go: mes 64 %',
    );
    expect(formatGoQuota({})).toBeNull();
  });

  it('el informe separa medido de estimado y muestra caché cuando la hay', () => {
    usage.recordUsage({
      sessionId: 'insp3',
      model: 'm',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 40,
      kind: 'turn',
      context: { system: 10, memory: 10, history: 10, tools: 10 },
    });
    const text = formatUsageReport(usage.usageReport(1));
    expect(text).toContain('medidos por el proveedor');
    expect(text).toContain('caché 40');
    expect(text).toContain('Contexto por turno');
  });
});

describe('parseGoQuota', () => {
  it('acepta la forma real del endpoint', () => {
    const quota = parseGoQuota({
      usage: {
        rolling: { status: 'ok', percent: 2, resetsAt: '2026-11-02T15:06:59.000Z' },
        weekly: { status: 'ok', percent: 9, resetsAt: '2026-11-09T00:00:00.000Z' },
        monthly: { status: 'ok', percent: 64, resetsAt: '2026-11-25T12:05:14.000Z' },
      },
    });
    expect(quota?.rolling?.percent).toBe(2);
    expect(quota?.monthly?.resetsAt).toBe('2026-11-25T12:05:14.000Z');
  });

  it('rechaza ruido: null, arrays, percent no numérico, usage ausente', () => {
    expect(parseGoQuota(null)).toBeNull();
    expect(parseGoQuota([])).toBeNull();
    expect(parseGoQuota({ usage: { rolling: { percent: '2' } } })).toBeNull();
    expect(parseGoQuota({ other: 1 })).toBeNull();
  });
});

describe('fetchGoQuota', () => {
  const okBody = { usage: { weekly: { status: 'ok', percent: 9 } } };

  it('endpoint no OpenCode: null sin tocar la red', async () => {
    let calls = 0;
    const quota = await fetchGoQuota('https://openrouter.ai/api/v1', {
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify(okBody));
      }) as never,
      getKey: async () => 'k',
    });
    expect(quota).toBeNull();
    expect(calls).toBe(0);
  });

  it('sin clave: null sin tocar la red', async () => {
    let calls = 0;
    const quota = await fetchGoQuota('https://opencode.ai/zen/go/v1', {
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify(okBody));
      }) as never,
      getKey: async () => undefined,
    });
    expect(quota).toBeNull();
    expect(calls).toBe(0);
  });

  it('200 parsea; error HTTP da null; la caché evita repetir la llamada', async () => {
    resetGoQuotaCache();
    let calls = 0;
    let ok = true;
    const fetchImpl = (async () => {
      calls++;
      if (!ok) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify(okBody));
    }) as never;
    const deps = { fetchImpl, getKey: async () => 'k' };
    expect((await fetchGoQuota('https://opencode.ai/zen/go/v1', deps))?.weekly?.percent).toBe(9);
    expect(calls).toBe(1);
    // Segunda lectura: sale de la caché.
    await fetchGoQuota('https://opencode.ai/zen/go/v1', deps);
    expect(calls).toBe(1);
    // Tras caducar, un 500 da null y no rompe.
    ok = false;
    resetGoQuotaCache();
    expect(await fetchGoQuota('https://opencode.ai/zen/go/v1', deps)).toBeNull();
  });
});

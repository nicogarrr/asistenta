import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleMcpMessage } from '../src/mcp/server.js';

// `sesiones_buscar` fechaba cada sesión con el día UTC: una conversación a las
// 00:30 de Madrid salía con la fecha del día anterior.
const deps = {
  memorySearch: () => [],
  sessionSearch: () => [
    {
      title: 'Cena',
      summary: 'Reserva para el sábado',
      snippet: '',
      at: Date.parse('2026-10-30T23:30:00Z'), // 00:30 del 31 en Madrid
    },
  ],
  goals: () => [],
  scrub: (s: string) => s,
};

describe('servidor MCP: sesiones con el día de Madrid', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  beforeEach(() => {
    process.env.TZ = 'Europe/Madrid';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
  });
  afterEach(() => {
    if (saved.tz === undefined) delete process.env.TZ;
    else process.env.TZ = saved.tz;
    if (saved.pa === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = saved.pa;
  });

  it('una sesión pasada la medianoche de Madrid lleva el día nuevo, no el UTC', () => {
    const r = handleMcpMessage(deps, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'sesiones_buscar', arguments: { consulta: 'cena' } },
    }) as { result?: { content: Array<{ text: string }> } };
    const text = r.result?.content[0]?.text ?? '';
    expect(text).toContain('- 2026-10-31 Cena');
    expect(text).not.toContain('2026-10-30');
  });
});

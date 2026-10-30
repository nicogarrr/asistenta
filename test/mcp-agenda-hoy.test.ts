import { describe, expect, it } from 'vitest';
import { scrubLogText } from '../src/log.js';
import { handleMcpMessage } from '../src/mcp/server.js';

const NOW = Date.UTC(2026, 9, 30, 9, 0); // viernes 30-oct, 10:00 en Madrid
const base = {
  memorySearch: () => [],
  sessionSearch: () => [],
  goals: () => [],
  scrub: scrubLogText,
  now: () => NOW,
  timeZone: 'Europe/Madrid',
};
const agenda = () => ({
  followups: [
    { subject: 'Llamar a Ana', dueAt: Date.UTC(2026, 9, 30, 15, 0) },
    { subject: 'Pagar factura de la luz', dueAt: Date.UTC(2026, 9, 28, 8, 0) },
    { subject: 'Cosa de mañana', dueAt: Date.UTC(2026, 9, 31, 10, 0) },
    { subject: 'Ya es sábado en Madrid', dueAt: Date.UTC(2026, 9, 30, 23, 30) },
    { subject: 'Sin fecha', dueAt: 0 },
    { subject: 'Token --password=hunter2 del banco', dueAt: Date.UTC(2026, 9, 30, 17, 0) },
  ],
  routines: [
    { name: 'resumen-noche', enabled: true, next: Date.UTC(2026, 9, 30, 19, 0) },
    { name: 'apagada', enabled: false, next: Date.UTC(2026, 9, 30, 12, 0) },
    { name: 'semanal', enabled: true, next: Date.UTC(2026, 10, 2, 7, 0) },
    { name: 'sin-horario', enabled: true, next: null },
  ],
});
const call = (deps: Parameters<typeof handleMcpMessage>[0]) =>
  handleMcpMessage(deps, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'agenda_hoy', arguments: {} },
  }) as { result?: { content: Array<{ text: string }>; isError: boolean }; error?: unknown };

describe('MCP agenda_hoy (solo lectura)', () => {
  it('lista los seguimientos de hoy, los vencidos y las rutinas que tocan hoy, en hora de Madrid', () => {
    const r = call({ ...base, agenda });
    expect(r.error).toBeUndefined();
    const text = r.result?.content[0]?.text ?? '';
    expect(r.result?.isError).toBe(false);
    expect(text).toMatch(/^Hoy, viernes, 30 de octubre:/);
    expect(text).toContain('- vencido 28/10 seguimiento: Pagar factura de la luz');
    expect(text).toContain('- 16:00 seguimiento: Llamar a Ana');
    expect(text).toContain('- 20:00 rutina: resumen-noche');
    expect(text.indexOf('Pagar factura')).toBeLessThan(text.indexOf('Llamar a Ana'));
    for (const no of [
      'Cosa de mañana',
      'Ya es sábado',
      'Sin fecha',
      'apagada',
      'semanal',
      'sin-horario',
    ]) {
      expect(text).not.toContain(no);
    }
  });

  it('pasa por el filtro de secretos', () => {
    const text = call({ ...base, agenda }).result?.content[0]?.text ?? '';
    expect(text).toContain('Token');
    expect(text).not.toContain('hunter2');
  });

  it('día vacío y servidor sin agenda: lo dice sin romper', () => {
    const empty = call({ ...base, agenda: () => ({ followups: [], routines: [] }) });
    expect(empty.result?.content[0]?.text).toMatch(/nada pendiente/);
    const none = call(base);
    expect(none.result?.isError).toBe(true);
    expect(none.result?.content[0]?.text).toMatch(/no está disponible/);
  });

  it('se anuncia como de solo lectura', () => {
    const r = handleMcpMessage(base, { jsonrpc: '2.0', id: 4, method: 'tools/list' }) as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    };
    const tool = r.result.tools.find((t) => t.name === 'agenda_hoy');
    expect(tool?.annotations.readOnlyHint).toBe(true);
  });
});

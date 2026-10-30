import { describe, expect, it } from 'vitest';
import { externalReadSource, Gate, type ToolCall } from '../src/permissions.js';

/**
 * F2 — puerta de contenido no confiable: tras leer contenido externo en la
 * sesión, ninguna concesión permanente cubre una llamada que no sea lectura.
 */
const S = 'chat-1';
const call = (tool: string, args: Record<string, unknown> = {}): ToolCall => ({
  tool,
  args,
  actor: 'owner',
});

function gateWith(opts: { taintGate?: boolean; taintTtlMs?: number } = {}) {
  const asked: string[] = [];
  const gate = new Gate({
    approver: async (c, reason) => {
      asked.push(`${c.tool}: ${reason}`);
      return true;
    },
    ...opts,
  });
  return { gate, asked };
}

describe('taint gate', () => {
  it('sin lectura externa, un permiso «siempre» no pregunta', async () => {
    const { gate, asked } = gateWith();
    gate.setScope(S, 'reminder', 'always');
    expect((await gate.check(S, call('reminder', { action: 'create' }))).verdict).toBe('allow');
    expect(asked).toEqual([]);
  });

  it('tras leer una página, el mismo permiso pregunta y nombra el origen', async () => {
    const { gate, asked } = gateWith();
    gate.setScope(S, 'reminder', 'always');
    await gate.check(S, call('fetch', { url: 'https://malo.example/x' }));
    expect(gate.taintOf(S)).toBe('página malo.example');
    const d = await gate.check(S, call('reminder', { action: 'create' }));
    expect(d.verdict).toBe('allow');
    expect(d.reason).toBe('approved by owner');
    const reminderAsks = asked.filter((a) => a.startsWith('reminder'));
    expect(reminderAsks).toHaveLength(1);
    expect(reminderAsks[0]).toContain('Tras leer contenido externo (página malo.example)');
  });

  it('la memoria de «ya aprobado en esta sesión» tampoco cubre tras leer contenido externo', async () => {
    const { gate, asked } = gateWith();
    const c = call('reminder', { action: 'create', text: 'x' });
    await gate.check(S, c);
    expect(asked).toHaveLength(1);
    await gate.check(S, call('web', { query: 'q' }));
    await gate.check(S, c);
    expect(asked.filter((a) => a.startsWith('reminder'))).toHaveLength(2);
  });

  it('un mensaje nuevo del dueño limpia la marca', async () => {
    const { gate, asked } = gateWith();
    gate.setScope(S, 'reminder', 'always');
    await gate.check(S, call('web', { query: 'q' }));
    gate.clearTaint(S);
    expect(gate.taintOf(S)).toBeNull();
    await gate.check(S, call('reminder', { action: 'create' }));
    expect(asked.filter((a) => a.startsWith('reminder'))).toEqual([]);
  });

  it('caduca sola y no afecta a otras sesiones', async () => {
    const { gate } = gateWith({ taintTtlMs: 1000 });
    gate.markTainted(S, 'página x', 0);
    expect(gate.taintOf(S, 500)).toBe('página x');
    expect(gate.taintOf(S, 2000)).toBeNull();
    gate.markTainted(S, 'página x');
    expect(gate.taintOf('otro-chat')).toBeNull();
  });

  it('las lecturas siguen sin preguntar aunque la sesión esté marcada', async () => {
    const { gate, asked } = gateWith();
    gate.setScope(S, 'fetch', 'always');
    gate.setScope(S, 'web', 'always');
    await gate.check(S, call('web', { query: 'q' }));
    await gate.check(S, call('fetch', { url: 'https://a.example' }));
    expect(asked).toEqual([]);
  });

  it('PA_TAINT_GATE=off (taintGate: false) deja el comportamiento anterior', async () => {
    const { gate, asked } = gateWith({ taintGate: false });
    gate.setScope(S, 'reminder', 'always');
    await gate.check(S, call('fetch', { url: 'https://malo.example' }));
    expect(gate.taintOf(S)).toBeNull();
    await gate.check(S, call('reminder', { action: 'create' }));
    expect(asked.filter((a) => a.startsWith('reminder'))).toEqual([]);
  });

  it('una lectura denegada no marca la sesión', async () => {
    const gate = new Gate({ approver: async () => false });
    await gate.check(S, call('fetch', { url: 'https://a.example' }));
    expect(gate.taintOf(S)).toBeNull();
  });

  it('externalReadSource reconoce las herramientas que traen texto de fuera', () => {
    expect(externalReadSource(call('browser', { url: 'https://shop.example/p' }))).toBe(
      'navegador shop.example',
    );
    expect(externalReadSource(call('documents'))).toBe('documento');
    expect(externalReadSource(call('mcp_github'))).toBe('herramienta MCP mcp_github');
    expect(externalReadSource(call('fetch', { url: 'no es url' }))).toBe('página');
    expect(externalReadSource(call('shell'))).toBeNull();
    expect(externalReadSource(call('memory'))).toBeNull();
  });
});

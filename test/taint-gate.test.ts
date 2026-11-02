import { describe, expect, it } from 'vitest';
import { externalReadSource, Gate, type ToolCall } from '../src/permissions.js';

/**
 * F2 — puerta de contenido no confiable: tras leer contenido externo en la
 * sesión, las clases SENSIBLES (dinero, credenciales, correo a terceros, shell
 * destructivo, instalaciones, objetivos, gestiones) pierden toda concesión y
 * vuelven a preguntar nombrando el origen. Los pasos normales de una tarea
 * del dueño (teclas, teclear, navegar, la tele) siguen las reglas de siempre:
 * «si yo le he pedido una cosa, que la haga» (Nico, 2-nov-2026).
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

  it('tras leer una página, un «Siempre» del dueño sigue valiendo en acciones normales', async () => {
    const { gate, asked } = gateWith();
    gate.setScope(S, 'reminder', 'always');
    await gate.check(S, call('fetch', { url: 'https://malo.example/x' }));
    expect(gate.taintOf(S)).toBe('página malo.example');
    const d = await gate.check(S, call('reminder', { action: 'create' }));
    expect(d.verdict).toBe('allow');
    expect(d.reason).toBe('always-allow scope');
    expect(asked.filter((a) => a.startsWith('reminder'))).toEqual([]);
  });

  it('tras leer una página, lo sensible SÍ vuelve a preguntar aunque haya «Siempre»', async () => {
    const { gate, asked } = gateWith();
    gate.setScope(S, 'correo', 'always');
    await gate.check(S, call('fetch', { url: 'https://malo.example/x' }));
    expect(gate.taintOf(S)).toBe('página malo.example');
    // Un correo a terceros lo ve Nico antes, con o sin marca y con o sin «Siempre».
    const d = await gate.check(S, call('correo', { action: 'responder', ref: '1', texto: 'ok' }));
    expect(d.verdict).toBe('allow');
    expect(d.reason).toBe('approved by owner');
    expect(asked.filter((a) => a.startsWith('correo'))).toHaveLength(1);
  });

  it('la memoria de «ya aprobado» cubre la acción normal aprobada, también tras leer fuera', async () => {
    const { gate, asked } = gateWith();
    const c = call('reminder', { action: 'create', text: 'x' });
    await gate.check(S, c);
    gate.settle(S, c, false, 'ok');
    expect(asked).toHaveLength(1);
    await gate.check(S, call('web', { query: 'q' }));
    const d = await gate.check(S, c);
    expect(d.reason).toBe('previously approved in this session');
    expect(asked.filter((a) => a.startsWith('reminder'))).toHaveLength(1);
  });

  it('la tele no repregunta tecla a tecla: una aprobación cubre la tarea (con marca o sin ella)', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('browser', { url: 'https://web.whatsapp.example/' }));
    expect(gate.taintOf(S)).toBe('navegador web.whatsapp.example');
    // Primera tecla: pregunta una vez (la acción general).
    const first = await gate.check(S, call('tv', { action: 'key', name: 'ENTER' }));
    expect(first.verdict).toBe('allow');
    expect(first.reason).toBe('approved by owner');
    expect(asked.filter((a) => a.startsWith('tv'))).toHaveLength(1);
    // El resto de pasos de la tarea (navegar el catálogo, teclear) ya no preguntan.
    for (const step of [
      call('tv', { action: 'key', name: 'RIGHT' }),
      call('tv', { action: 'key', name: 'R' }),
      call('tv', { action: 'type', text: 'documental' }),
    ]) {
      const d = await gate.check(S, step);
      expect(d.verdict).toBe('allow');
      expect(d.reason).toBe('within the approval window');
    }
    expect(asked.filter((a) => a.startsWith('tv'))).toHaveLength(1);
  });

  it('ni con la tarea de tele aprobada, un número con pinta de tarjeta vuelve a preguntar', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('browser', { url: 'https://tienda.example/' }));
    await gate.check(S, call('tv', { action: 'key', name: 'ENTER' }));
    const d = await gate.check(S, call('tv', { action: 'type', text: '4111111111111111' }));
    expect(d.reason).toBe('approved by owner');
    const tvAsks = asked.filter((a) => a.startsWith('tv'));
    expect(tvAsks).toHaveLength(2);
    expect(tvAsks[1]).toContain('Tras leer contenido externo (navegador tienda.example)');
  });

  it('tras leer fuera, un shell destructivo vuelve a preguntar nombrando el origen', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('web', { query: 'q' }));
    await gate.check(S, call('shell', { command: 'Remove-Item -Recurse x' }));
    const shellAsks = asked.filter((a) => a.startsWith('shell'));
    expect(shellAsks).toHaveLength(1);
    expect(shellAsks[0]).toContain('Tras leer contenido externo');
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

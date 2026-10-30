import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { scrubLogText } from '../src/log.js';
import { ownerChatKey } from '../src/mcp/serve-cli.js';
import { handleMcpMessage, READ_ONLY_TOOLS, serveMcpStdio } from '../src/mcp/server.js';

const deps = {
  memorySearch: (q: string, limit: number) =>
    [
      { date: '2026-10-30', text: `Clave del banco: --password=hunter2 (${q})` },
      { date: '2026-10-29', text: 'Le gusta el café solo' },
    ].slice(0, limit),
  sessionSearch: () => [
    { title: 'Lisboa', summary: 'Escapada a Lisboa', snippet: '', at: Date.UTC(2026, 9, 1) },
  ],
  goals: () => [{ title: 'Correr 5 km', status: 'active', cadence: '0 8 * * 1' }],
  scrub: scrubLogText,
};
const call = (name: string, args: unknown = {}) =>
  handleMcpMessage(deps, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: args },
  }) as {
    result?: { content: Array<{ text: string }>; isError: boolean };
    error?: { code: number };
  };

describe('F9 servidor MCP de solo lectura', () => {
  it('initialize anuncia solo tools y respeta la versión pedida', () => {
    const r = handleMcpMessage(deps, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    }) as {
      result: { protocolVersion: string; capabilities: object; serverInfo: { name: string } };
    };
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(Object.keys(r.result.capabilities)).toEqual(['tools']);
    expect(r.result.serverInfo.name).toBe('asistenta');
  });

  it('tools/list: solo las cuatro de lectura, ninguna que escriba', () => {
    const r = handleMcpMessage(deps, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    };
    const names = r.result.tools.map((t) => t.name);
    expect(names).toEqual(['memoria_buscar', 'sesiones_buscar', 'objetivos_listar', 'agenda_hoy']);
    expect(names.some((n) => /guardar|borrar|crear|enviar|escribir|set|write|delete/.test(n))).toBe(
      false,
    );
    expect(r.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(READ_ONLY_TOOLS).toHaveLength(4);
  });

  it('memoria_buscar tapa secretos y respeta el límite', () => {
    const r = call('memoria_buscar', { consulta: 'banco', limite: 1 });
    const text = r.result?.content[0]?.text ?? '';
    expect(text).toContain('[2026-10-30] Clave del banco');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('café');
  });

  it('sesiones y objetivos se listan; sin consulta es error de la tool', () => {
    expect(call('sesiones_buscar', { consulta: 'lisboa' }).result?.content[0]?.text).toContain(
      '2026-10-01 Lisboa: Escapada a Lisboa',
    );
    expect(call('objetivos_listar').result?.content[0]?.text).toBe(
      '- Correr 5 km (active, 0 8 * * 1)',
    );
    const bad = call('memoria_buscar', {});
    expect(bad.result?.isError).toBe(true);
  });

  it('tool desconocida, método desconocido y notificaciones', () => {
    expect(call('memoria_guardar', { texto: 'x' }).error?.code).toBe(-32602);
    expect(
      (
        handleMcpMessage(deps, { jsonrpc: '2.0', id: 3, method: 'resources/write' }) as {
          error: { code: number };
        }
      ).error.code,
    ).toBe(-32601);
    expect(
      handleMcpMessage(deps, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeNull();
  });

  it('por stdio: una respuesta por línea, JSON roto da -32700', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let got = '';
    output.on('data', (c) => {
      got += String(c);
    });
    const done = serveMcpStdio(deps, input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write('{nope\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.end();
    await done;
    const lines = got
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(lines[1].error.code).toBe(-32700);
  });

  it('el chat del dueño sale del vault como el daemon (un único usuario permitido)', async () => {
    const vault = (m: Record<string, string>) => async (k: string) => m[k] ?? null;
    expect(await ownerChatKey(vault({ 'telegram:allowedUserIds': '42' }))).toBe('telegram:dm:42');
    expect(await ownerChatKey(vault({ 'telegram:allowedUserIds': '42,43' }))).toBeNull();
    expect(
      await ownerChatKey(
        vault({ 'telegram:allowedUserIds': '42,43', 'vigilante:ownerUserId': '43' }),
      ),
    ).toBe('telegram:dm:43');
  });
});

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../src/mcp/client.js';
import { createMcpTools, mcpResourcesEnabled } from '../src/mcp/tools.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

function echo(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: 'echo', command: process.execPath, args: [FIXTURE], ...extra };
}

type Tool = Awaited<ReturnType<typeof createMcpTools>>[number];
async function run(tool: Tool | undefined, args: Record<string, unknown>) {
  if (!tool) throw new Error('tool ausente');
  const result = await tool.execute('t1', args as never);
  const first = result.content[0];
  return {
    text: first && first.type === 'text' ? first.text : '',
    isError: Boolean((result as { isError?: boolean }).isError),
  };
}

describe('MCP: recursos y prompts para el asistente', () => {
  it('apagado por defecto: sin PA_MCP_RESOURCES=1 no hay herramientas nuevas', async () => {
    expect(mcpResourcesEnabled({})).toBe(false);
    expect(mcpResourcesEnabled({ PA_MCP_RESOURCES: '0' })).toBe(false);
    expect(mcpResourcesEnabled({ PA_MCP_RESOURCES: '1' })).toBe(true);
    const tools = await createMcpTools([echo()], [], { resources: false });
    expect(tools.map((t) => t.name)).not.toContain('mcp_echo_leer_recurso');
    expect(tools.map((t) => t.name)).not.toContain('mcp_echo_usar_prompt');
  });

  it('lista y lee recursos anunciados; marcados como MCP externo', async () => {
    const tools = await createMcpTools([echo()], [], { resources: true });
    const leer = tools.find((t) => t.name === 'mcp_echo_leer_recurso');
    expect(leer?.description).toContain('MCP externo');
    const list = await run(leer, {});
    expect(list.text).toContain('echo://saludo');
    expect(list.text).toContain('Saludo');
    const read = await run(leer, { uri: 'echo://saludo' });
    expect(read).toEqual({ text: 'hola desde el fixture', isError: false });
  });

  it('se niega a leer una URI que el servidor no anuncia', async () => {
    const tools = await createMcpTools([echo()], [], { resources: true });
    const leer = tools.find((t) => t.name === 'mcp_echo_leer_recurso');
    const out = await run(leer, { uri: 'file:///etc/passwd' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('no está entre los recursos');
  });

  it('lista prompts, exige argumentos obligatorios y devuelve el texto', async () => {
    const tools = await createMcpTools([echo()], [], { resources: true });
    const prompt = tools.find((t) => t.name === 'mcp_echo_usar_prompt');
    expect((await run(prompt, {})).text).toContain('saludo (nombre*)');
    const missing = await run(prompt, { nombre: 'saludo' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('nombre');
    const ok = await run(prompt, { nombre: 'saludo', argumentos: { nombre: 'Nico' } });
    expect(ok.text).toContain('[user] Hola, Nico.');
    expect((await run(prompt, { nombre: 'otro' })).isError).toBe(true);
  });

  it('con allowedTools solo se publican si se nombran @recursos / @prompts', async () => {
    const closed = await createMcpTools([echo({ allowedTools: ['echo'] })], [], {
      resources: true,
    });
    expect(closed.map((t) => t.name)).toEqual(['mcp_echo_echo']);
    const open = await createMcpTools([echo({ allowedTools: ['@recursos'] })], [], {
      resources: true,
    });
    expect(open.map((t) => t.name)).toEqual(['mcp_echo_leer_recurso']);
  });
});

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../src/mcp/client.js';
import * as tools from '../src/mcp/tools.js';
import { createMcpTools } from '../src/mcp/tools.js';

// Plantillas de recursos MCP (resources/templates/list): solo lectura, solo las
// plantillas que el servidor anuncia, apagado por defecto (PA_MCP_RESOURCE_TEMPLATES=1).
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const echo = (): McpServerConfig => ({ name: 'echo', command: process.execPath, args: [FIXTURE] });
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
const leer = async (templates: boolean) =>
  (await createMcpTools([echo()], [], { resources: true, templates } as never)).find(
    (t) => t.name === 'mcp_echo_leer_recurso',
  );
const enabled = () =>
  (tools as unknown as Record<string, unknown>).mcpResourceTemplatesEnabled as
    | ((env: NodeJS.ProcessEnv) => boolean)
    | undefined;

describe('MCP: plantillas de recursos', () => {
  it('apagado por defecto: solo con PA_MCP_RESOURCE_TEMPLATES=1', async () => {
    expect(enabled()?.({})).toBe(false);
    expect(enabled()?.({ PA_MCP_RESOURCE_TEMPLATES: 'true' })).toBe(false);
    expect(enabled()?.({ PA_MCP_RESOURCE_TEMPLATES: '1' })).toBe(true);
    const tool = await leer(false);
    expect((await run(tool, {})).text).not.toContain('echo://nota/{nombre}');
    const out = await run(tool, { plantilla: 'echo://nota/{nombre}', valores: { nombre: 'a' } });
    expect(out.text).not.toContain('leída');
  });

  it('activado: el listado incluye las plantillas y lee una rellenada', async () => {
    const tool = await leer(true);
    const list = await run(tool, {});
    expect(list.text).toContain('echo://saludo');
    expect(list.text).toContain('echo://nota/{nombre}');
    const out = await run(tool, {
      plantilla: 'echo://nota/{nombre}',
      valores: { nombre: 'compra semanal' },
    });
    expect(out).toEqual({ text: 'leída echo://nota/compra%20semanal', isError: false });
  });

  it('los valores no pueden salirse de la plantilla (/, .., ?, #)', async () => {
    const tool = await leer(true);
    const slash = await run(tool, {
      plantilla: 'echo://nota/{nombre}',
      valores: { nombre: '../../etc/passwd' },
    });
    expect(slash.text).toBe('leída echo://nota/..%2F..%2Fetc%2Fpasswd');
    for (const nombre of ['..', '.', '']) {
      const out = await run(tool, { plantilla: 'echo://nota/{nombre}', valores: { nombre } });
      expect(out.isError).toBe(true);
    }
    const q = await run(tool, { plantilla: 'echo://nota/{nombre}', valores: { nombre: 'a?b#c' } });
    expect(q.text).toBe('leída echo://nota/a%3Fb%23c');
  });

  it('se niega a plantillas no anunciadas, con operadores o con valores que faltan', async () => {
    const tool = await leer(true);
    const ajena = await run(tool, { plantilla: 'file:///{ruta}', valores: { ruta: 'etc' } });
    expect(ajena.isError).toBe(true);
    expect(ajena.text).toContain('no está entre las plantillas');
    const raw = await run(tool, { plantilla: 'echo://raw{+ruta}', valores: { ruta: '/x' } });
    expect(raw.isError).toBe(true);
    const falta = await run(tool, { plantilla: 'echo://nota/{nombre}', valores: {} });
    expect(falta.isError).toBe(true);
    expect(falta.text).toContain('nombre');
  });
});

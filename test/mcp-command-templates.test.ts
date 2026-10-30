import { describe, expect, it } from 'vitest';
import { mcpCommandText } from '../src/mcp/tools.js';

const server = (templates: () => Promise<unknown[]>) =>
  ({
    name: 'notas',
    client: {
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      listResources: async () => [{ uri: 'notas://hoy', name: 'Hoy' }],
      listPrompts: async () => [],
      listResourceTemplates: templates,
    },
  }) as never;

const ON = { PA_MCP_RESOURCES: '1', PA_MCP_RESOURCE_TEMPLATES: '1' };

describe('/mcp recursos con plantillas', () => {
  it('con PA_MCP_RESOURCE_TEMPLATES=1 lista también las plantillas', async () => {
    const text = await mcpCommandText('recursos', {
      env: ON,
      servers: [server(async () => [{ uriTemplate: 'notas://{id}', name: 'nota' }])],
    });
    expect(text).toContain('Hoy (notas://hoy)');
    expect(text).toContain('plantilla nota (notas://{id})');
  });

  it('sin la variable no pide ni muestra plantillas', async () => {
    let asked = false;
    const text = await mcpCommandText('recursos', {
      env: { PA_MCP_RESOURCES: '1' },
      servers: [
        server(async () => {
          asked = true;
          return [{ uriTemplate: 'notas://{id}' }];
        }),
      ],
    });
    expect(asked).toBe(false);
    expect(text).not.toContain('plantilla');
  });

  it('si las plantillas fallan, los recursos se siguen viendo', async () => {
    const text = await mcpCommandText('recursos', {
      env: ON,
      servers: [
        server(async () => {
          throw new Error('x');
        }),
      ],
    });
    expect(text).toContain('Hoy (notas://hoy)');
    expect(text).toContain('plantillas: no responden');
  });

  it('/mcp prompts no muestra plantillas', async () => {
    const text = await mcpCommandText('prompts', {
      env: ON,
      servers: [server(async () => [{ uriTemplate: 'notas://{id}' }])],
    });
    expect(text).not.toContain('plantilla');
  });
});

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import type { McpServerConfig } from '../src/mcp/client.js';
import * as tools from '../src/mcp/tools.js';

// /mcp recursos|prompts en Telegram: solo lectura, apagado sin PA_MCP_RESOURCES=1,
// respeta allowedTools (@recursos/@prompts). Servidor MCP falso (fixture).
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const ON = { PA_MCP_RESOURCES: '1' };
type Mod = typeof tools;
const m = tools as Partial<Mod>;
type Live = NonNullable<Parameters<NonNullable<Mod['mcpCommandText']>>[1]>['servers'];

function fake(name: string, extra: Record<string, unknown> = {}): NonNullable<Live>[number] {
  return {
    name,
    client: {
      listResources: async () => [],
      listPrompts: async () => [],
    },
    ...extra,
  } as NonNullable<Live>[number];
}

describe('/mcp recursos|prompts', () => {
  it('está en el menú de Telegram', () => {
    expect(TELEGRAM_COMMANDS.some((c) => c.command === 'mcp')).toBe(true);
  });

  it('apagado por defecto y uso claro con un argumento desconocido', async () => {
    expect(typeof m.mcpCommandText).toBe('function');
    expect(await m.mcpCommandText?.('recursos', { env: {}, servers: [fake('a')] })).toMatch(
      /PA_MCP_RESOURCES=1/,
    );
    expect(await m.mcpCommandText?.('borra todo', { env: ON, servers: [fake('a')] })).toBe(
      m.MCP_COMMAND_USAGE,
    );
    expect(await m.mcpCommandText?.('prompts', { env: ON, servers: [] })).toMatch(
      /ningún servidor/,
    );
  });

  it('lista los recursos y prompts de un servidor real en marcha (fixture)', async () => {
    const echo: McpServerConfig = { name: 'echo', command: process.execPath, args: [FIXTURE] };
    await tools.createMcpTools([echo], [], { resources: true });
    const rec = await m.mcpCommandText?.('recursos', { env: ON });
    expect(rec).toContain('echo:');
    expect(rec).toContain('echo://saludo');
    const pr = await m.mcpCommandText?.(' Prompts ', { env: ON });
    expect(pr).toContain('saludo');
  });

  it('respeta allowedTools, aísla un servidor que falla o no responde y tapa caracteres de control', async () => {
    const hang = fake('lento', {
      client: { listResources: () => new Promise(() => {}), listPrompts: async () => [] },
    });
    const broken = fake('roto', {
      client: {
        listResources: async () => {
          throw new Error('boom');
        },
        listPrompts: async () => [],
      },
    });
    const limited = fake('solo-tools', { allowedTools: ['buscar'] });
    const ok = fake('bien', {
      client: {
        listResources: async () => [{ uri: 'x://1', name: 'Uno\nFALSO: línea' }],
        listPrompts: async () => [],
      },
    });
    const text = await m.mcpCommandText?.('recursos', {
      env: ON,
      servers: [hang, broken, limited, ok],
      timeoutMs: 50,
    });
    expect(text).toContain('lento: no responde');
    expect(text).toContain('roto: no responde');
    expect(text).toContain('solo-tools: no publicado (falta @recursos en allowedTools)');
    expect(text).toContain('• Uno FALSO: línea (x://1)');
    expect(text).not.toContain('boom');
  });

  it('pone tope a la lista', async () => {
    const many = fake('muchos', {
      client: {
        listResources: async () => Array.from({ length: 30 }, (_, i) => ({ uri: `x://${i}` })),
        listPrompts: async () => [],
      },
    });
    const text = (await m.mcpCommandText?.('recursos', { env: ON, servers: [many] })) ?? '';
    expect(text.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(20);
    expect(text).toContain('… y 10 más');
  });
});

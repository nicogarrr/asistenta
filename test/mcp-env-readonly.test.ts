import { fileURLToPath } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { launchBaseEnv } from '../src/mcp/client.js';
import { createMcpTools, isReadOnlyTool } from '../src/mcp/tools.js';

// Servidor MCP falso con pistas de solo lectura (como las de REA).
const FAKE = fileURLToPath(new URL('./fixtures/mcp-rea-fake.mjs', import.meta.url));

describe('MCP: entorno mínimo y solo lectura (opcionales por servidor)', () => {
  it('con lista de entorno solo pasan esas variables; sin ella, todo como antes', () => {
    const env = { PATH: '/bin', Path: 'C:\\bin', TEMP: '/t', PA_TELEGRAM_TOKEN: 's' };
    expect(Object.keys(launchBaseEnv(env, ['path', 'TEMP'])).sort()).toEqual([
      'PATH',
      'Path',
      'TEMP',
    ]);
    expect(launchBaseEnv(env, undefined)).toEqual(env);
  });

  it('solo publica tools de solo lectura o no destructivas y el proceso no ve secretos', async () => {
    process.env.PA_MCP_TEST_SECRET = 'no-debe-verse';
    const cfg = {
      name: 'fake',
      command: process.execPath,
      args: [FAKE],
      envAllowlist: ['PATH'],
      readOnlyOnly: true,
    };
    const tools = await createMcpTools([cfg], [], { resources: false });
    delete process.env.PA_MCP_TEST_SECRET;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mcp_fake_analyze_app',
      'mcp_fake_env_report',
      'mcp_fake_record_evidence',
    ]);
    const report = tools.find((t) => t.name === 'mcp_fake_env_report') as AgentTool;
    const names = ((await report.execute('c', {})).content[0] as { text: string }).text.split(',');
    expect(names).not.toContain('PA_MCP_TEST_SECRET');
    expect(names).toContain('PATH');
  });

  it('sin readOnlyOnly se publican todas, como antes', async () => {
    const tools = await createMcpTools(
      [{ name: 'todo', command: process.execPath, args: [FAKE] }],
      [],
      {
        resources: false,
      },
    );
    expect(tools).toHaveLength(5);
  });

  it('sin pistas, o destructiva aunque diga solo lectura, no cuenta como solo lectura', () => {
    expect(isReadOnlyTool({ name: 'x' })).toBe(false);
    expect(
      isReadOnlyTool({ name: 'x', annotations: { readOnlyHint: true, destructiveHint: true } }),
    ).toBe(false);
    expect(isReadOnlyTool({ name: 'x', annotations: { destructiveHint: false } })).toBe(true);
  });
});

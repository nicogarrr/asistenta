import { fileURLToPath } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { launchBaseEnv, McpClient } from '../src/mcp/client.js';
import {
  EMPLEO_ALLOWED_TOOLS,
  EMPLEO_MISSING_LINE,
  EMPLEO_SERVER_NAME,
  empleoEnabled,
  empleoScriptPath,
  empleoServerConfig,
  guardEmpleoTools,
  withEmpleo,
} from '../src/mcp/empleo.js';
import { createMcpTools } from '../src/mcp/tools.js';
import { REPO_DIR } from '../src/paths.js';

const noFile = () => false;
const yesFile = () => true;
const FIXTURE = fileURLToPath(new URL('./fixtures/empleo-data.json', import.meta.url));

describe('MCP empleo: interruptor y arranque', () => {
  it('encendido salvo PA_EMPLEO=0', () => {
    expect([
      empleoEnabled({}),
      empleoEnabled({ PA_EMPLEO: '0' }),
      empleoEnabled({ PA_EMPLEO: 'no' }),
    ]).toEqual([true, false, false]);
    expect(empleoEnabled({ PA_EMPLEO: '1' })).toBe(true);
  });

  it('aparta una entrada «empleo» de PA_MCP_SERVERS y respeta el apagado', () => {
    const own = [
      { name: EMPLEO_SERVER_NAME, command: 'evil' },
      { name: 'otro', command: 'x' },
    ];
    expect(withEmpleo(own, { PA_EMPLEO: '0' })).toBe(own);
    const on = withEmpleo(own, {}, yesFile, () => {}, '/node', '/repo');
    expect(on.map((s) => s.name)).toEqual(['otro', EMPLEO_SERVER_NAME]);
    expect(on[1]?.command).toBe('/node');
  });

  it('sin el vendor no arranca ni bloquea: avisa una vez en castellano', () => {
    const lines: string[] = [];
    const none = withEmpleo([], {}, noFile, (l) => lines.push(l), '/node', '/repo');
    expect(none).toEqual([]);
    expect(lines).toEqual([EMPLEO_MISSING_LINE]);
  });

  it('arranca con el mismo Node que ejecuta Asistenta y el script vendado', () => {
    const config = empleoServerConfig('/node24/node', '/repo');
    expect(config.command).toBe('/node24/node');
    expect(config.args).toEqual([empleoScriptPath('/repo')]);
    expect(config.readOnlyOnly).toBe(true);
    expect(config.reconnect).toBe(true);
  });

  it('solo publica tools de lectura: fuera report_application, hiring_contact y application_guide', () => {
    const allowed = empleoServerConfig().allowedTools ?? [];
    expect([...allowed].sort()).toEqual([...EMPLEO_ALLOWED_TOOLS].sort());
    for (const banned of ['report_application', 'hiring_contact', 'application_guide']) {
      expect(allowed).not.toContain(banned);
    }
  });

  it('no pasa las claves del .env: solo la lista mínima', () => {
    const env = {
      PATH: '/bin',
      TEMP: '/t',
      PA_TELEGRAM_TOKEN: 's',
      DEEPSEEK_API_KEY: 's',
      TECH_PAY_DATA: 'https://evil.example/data.json',
    };
    const seen = launchBaseEnv(env, empleoServerConfig().envAllowlist);
    expect(Object.keys(seen).sort()).toEqual(['PATH', 'TEMP']);
  });
});

describe('MCP empleo: pista para el modelo', () => {
  const tool = (name: string): AgentTool => ({ name, description: 'desc' }) as unknown as AgentTool;

  it('solo toca las tools mcp_empleo_*', () => {
    const [empleoTool, otra] = guardEmpleoTools([tool('mcp_empleo_find_jobs'), tool('mcp_rea_x')]);
    expect(empleoTool?.description).toContain('Empleo tech en España');
    expect(empleoTool?.description).toContain('no envía candidaturas');
    expect(otra?.description).toBe('desc');
  });
});

describe('MCP empleo: servidor vendado en vivo (fixture local, sin red)', () => {
  it('habla MCP por stdio y lista sus tools', async () => {
    const client = new McpClient({
      name: EMPLEO_SERVER_NAME,
      command: process.execPath,
      args: [empleoScriptPath(REPO_DIR), FIXTURE],
      timeoutMs: 20_000,
    });
    try {
      await client.start();
      const names = (await client.listTools()).map((t) => t.name).sort();
      // hiring_contact no se ofrece sin el fichero privado de contactos.
      expect(names).toEqual(
        [
          'application_guide',
          'company_salaries',
          'find_jobs',
          'job_questions',
          'list_filters',
          'report_application',
          'salary_stats',
          'top_companies',
        ].sort(),
      );
      const out = await client.callTool('list_filters', {});
      expect(out.isError).toBe(false);
      expect(out.text).toContain('software-engineer');
      expect(out.text).toContain('Madrid');
    } finally {
      client.close();
    }
  });

  it('createMcpTools deja solo las seis tools de lectura, como mcp_empleo_*', async () => {
    const config = { ...empleoServerConfig(), args: [empleoScriptPath(REPO_DIR), FIXTURE] };
    const tools = await createMcpTools([config], [], { resources: false });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [...EMPLEO_ALLOWED_TOOLS].map((t) => `mcp_${EMPLEO_SERVER_NAME}_${t}`).sort(),
    );
  });
});

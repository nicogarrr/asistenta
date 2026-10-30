import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as tools from '../src/mcp/tools.js';

// `pa doctor` debe decir si los recursos y prompts MCP (PA_MCP_RESOURCES) están
// activados y qué servidores podrían publicar leer_recurso / usar_prompt, sin
// conectar con ningún servidor.
const servers = JSON.stringify([
  { name: 'docs', command: 'node', args: ['docs.js'] },
  { name: 'git', command: 'node', args: ['git.js'], allowedTools: ['status', '@recursos'] },
  { name: 'solo', command: 'node', args: ['solo.js'], allowedTools: ['status'] },
  { name: 'remoto', url: 'https://mcp.example.com/mcp?key=abc', allowedTools: ['@prompts'] },
]);
type Doctor = (env: NodeJS.ProcessEnv) => string[];
const doctor = () =>
  (tools as unknown as Record<string, unknown>).mcpResourcesDoctorLines as Doctor | undefined;
const run = (env: NodeJS.ProcessEnv) => doctor()?.(env).join('\n') ?? '';

describe('pa doctor: recursos y prompts MCP', () => {
  it('existe mcpResourcesDoctorLines y pa doctor la usa', () => {
    expect(typeof doctor()).toBe('function');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const body = cli.slice(cli.indexOf('async function doctorCommand'));
    expect(body.slice(0, body.indexOf('\nfunction '))).toMatch(/mcpResourcesDoctorLines\(\)/);
  });

  it('apagado por defecto: lo dice y no lista servidores', () => {
    const text = run({ PA_MCP_SERVERS: servers });
    expect(text).toContain('apagado (PA_MCP_RESOURCES=1 para activarlo)');
    expect(text).not.toContain('docs');
    expect(run({ PA_MCP_SERVERS: servers, PA_MCP_RESOURCES: 'true' })).toContain('apagado');
  });

  it('activado: por servidor, qué publicaría según allowedTools', () => {
    const text = run({ PA_MCP_SERVERS: servers, PA_MCP_RESOURCES: '1' });
    expect(text).toContain('activado (PA_MCP_RESOURCES=1)');
    expect(text).toContain(
      'docs: mcp_docs_leer_recurso y mcp_docs_usar_prompt (si el servidor los lista)',
    );
    expect(text).toContain(
      'git: mcp_git_leer_recurso (si el servidor los lista); prompts no: falta @prompts en allowedTools',
    );
    expect(text).toContain('solo: ninguno: allowedTools sin @recursos ni @prompts');
    // Con PA_MCP_HTTP apagado, el servidor HTTP no se usa: no aparece.
    expect(text).not.toContain('remoto');
  });

  it('servidores HTTP solo con PA_MCP_HTTP=1, y nunca la URL', () => {
    const text = run({ PA_MCP_SERVERS: servers, PA_MCP_RESOURCES: '1', PA_MCP_HTTP: '1' });
    expect(text).toContain(
      'remoto: mcp_remoto_usar_prompt (si el servidor los lista); recursos no: falta @recursos en allowedTools',
    );
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('key=abc');
  });

  it('activado sin servidores o con JSON inválido: lo dice sin fallar', () => {
    expect(run({ PA_MCP_RESOURCES: '1' })).toContain('sin servidores en PA_MCP_SERVERS');
    expect(run({ PA_MCP_RESOURCES: '1', PA_MCP_SERVERS: '{no' })).toContain(
      'sin servidores en PA_MCP_SERVERS',
    );
  });
});

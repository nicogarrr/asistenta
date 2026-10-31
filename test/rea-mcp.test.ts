import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { launchBaseEnv } from '../src/mcp/client.js';
import { guardReaTools, reaEnabled, reaServerConfig, withRea } from '../src/mcp/rea.js';
import { Gate } from '../src/permissions.js';

const noFile = () => false;
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
const launch = (c: { command: string; args?: string[] }) => [c.command, ...(c.args ?? [])];

describe('REA: interruptor y arranque', () => {
  it('apagado por defecto; con PA_REA=1 se añade y aparta otra entrada «rea»', () => {
    expect([reaEnabled({}), reaEnabled({ PA_REA: 'true' }), reaEnabled({ PA_REA: ' 1 ' })]).toEqual(
      [false, false, true],
    );
    const own = [
      { name: 'rea', command: 'evil' },
      { name: 'otro', command: 'x' },
    ];
    expect(withRea(own, {})).toBe(own);
    const on = withRea(own, { PA_REA: '1', PATH: '' });
    expect(on.map((s) => s.name)).toEqual(['otro', 'rea']);
    expect(on[1]?.command).not.toBe('evil');
  });

  it('npx -y rea-agents sin rea global, rea si lo hay, y cmd.exe en Windows', () => {
    const npx = reaServerConfig({ PATH: '/usr/bin' }, 'linux', noFile);
    expect(launch(npx)).toEqual(['npx', '-y', 'rea-agents', 'mcp']);
    expect(npx.readOnlyOnly).toBe(true);
    expect(launch(reaServerConfig({ PATH: '/opt' }, 'linux', (p) => p === '/opt/rea'))).toEqual([
      'rea',
      'mcp',
    ]);
    const win = reaServerConfig({ Path: 'C:\\npm' }, 'win32', (p) => p.endsWith('rea.cmd'));
    expect(launch(win)).toEqual(['cmd.exe', '/d', '/s', '/c', 'rea', 'mcp']);
  });

  it('no pasa las claves del .env: solo la lista mínima y los ajustes REA_*', () => {
    const env = {
      PATH: '/bin',
      Path: 'C:\\bin',
      TEMP: '/t',
      PA_TELEGRAM_TOKEN: 's',
      DEEPSEEK_API_KEY: 's',
      REA_X_MS: '9',
    };
    const seen = launchBaseEnv(env, reaServerConfig(env, 'linux', noFile).envAllowlist);
    expect(Object.keys(seen).sort()).toEqual(['PATH', 'Path', 'REA_X_MS', 'TEMP']);
    // Los demás servidores MCP siguen recibiendo el entorno entero, como antes.
    expect(launchBaseEnv(env, undefined)).toEqual(env);
  });
});

describe('REA: solo el dueño', () => {
  it('fuera del chat del dueño contesta en castellano y no llama a REA', async () => {
    const tool = (name: string): AgentTool => ({
      name,
      label: name,
      description: 'Inspect.',
      parameters: {} as never,
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
    });
    let owner = false;
    const [rea, other] = guardReaTools([tool('mcp_rea_a'), tool('mcp_otro_x')], () => owner) as [
      AgentTool,
      AgentTool,
    ];
    expect(rea.description).toContain('«qué hace este .exe»');
    expect(other.description).toBe('Inspect.');
    const refused = await rea.execute('c1', {});
    expect([refused.isError, text(refused)]).toEqual([
      true,
      'Analizar apps por dentro solo lo puede pedir el dueño.',
    ]);
    owner = true;
    expect(text(await rea.execute('c2', {}))).toBe('ok');
  });
});

describe('REA: cada llamada pide permiso', () => {
  const call = {
    tool: 'mcp_rea_analyze_app',
    args: { target: 'C:\\app.exe' },
    actor: 'local' as const,
  };
  const counting = (answer: boolean, opts: { allow?: string[]; fullControl?: boolean }) => {
    const seen = { asked: 0 };
    const gate = new Gate({
      ...opts,
      approver: () => {
        seen.asked++;
        return answer;
      },
    });
    return { gate, seen };
  };

  it('pregunta siempre, aunque esté en la lista libre, con control total o ya aprobada', async () => {
    const { gate, seen } = counting(true, { allow: [call.tool], fullControl: true });
    expect((await gate.check('s1', call)).verdict).toBe('allow');
    expect((await gate.check('s1', call)).verdict).toBe('allow');
    expect(seen.asked).toBe(2);
    expect((await counting(false, { allow: [call.tool] }).gate.check('s1', call)).verdict).toBe(
      'deny',
    );
    // Otro servidor MCP en la lista libre sigue igual que antes.
    const other = counting(false, { allow: ['mcp_otro_x'] }).gate;
    expect(
      (await other.check('s1', { tool: 'mcp_otro_x', args: {}, actor: 'local' })).verdict,
    ).toBe('allow');
  });

  it('lo que devuelve REA cuenta como contenido de fuera', async () => {
    const { gate, seen } = counting(true, { fullControl: true });
    const write = {
      tool: 'write',
      args: { path: 'notas.txt', content: 'x' },
      actor: 'local' as const,
    };
    await gate.check('s1', write);
    await gate.check('s1', call);
    await gate.check('s1', write);
    expect(seen.asked).toBe(2);
  });
});

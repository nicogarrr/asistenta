import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const call = (tool: string, args: Record<string, unknown> = {}): ToolCall => ({
  tool,
  args,
  actor: 'owner',
});

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    allow: ['delegate'],
    approver: async (c, reason) => {
      if (c.tool === 'write') asked.push(reason);
      return true;
    },
  });
  // Un «Siempre» para escribir ficheros: sin lectura externa no pregunta.
  g.setScope(S, 'write', 'always');
  return { g, asked };
}

const WRITE = call('write', { path: 'C:\\Users\\nico\\notas.txt', content: 'hola' });

describe('un subagente que busca en la web cuenta como lectura externa', () => {
  it('tras delegar una búsqueda web, escribir pregunta aunque haya «Siempre»', async () => {
    const { g, asked } = gate();
    await g.check(S, call('delegate', { task: 'busca opiniones del portátil X' }));
    await g.check(S, WRITE);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/subagente/);
  });

  it('explorer con fetch explícito también cuenta', async () => {
    const { g, asked } = gate();
    await g.check(
      S,
      call('delegate', { task: 'lee https://x.example', role: 'explorer', tools: ['fetch'] }),
    );
    await g.check(S, WRITE);
    expect(asked).toHaveLength(1);
  });

  it('un planner o un explorer solo con ficheros locales no cuenta', async () => {
    const { g, asked } = gate();
    await g.check(S, call('delegate', { task: 'plan', role: 'planner' }));
    await g.check(
      S,
      call('delegate', { task: 'mira src', role: 'explorer', tools: ['read', 'list'] }),
    );
    await g.check(S, WRITE);
    expect(asked).toEqual([]);
  });

  it('sin delegar, el «Siempre» sigue valiendo', async () => {
    const { g, asked } = gate();
    expect((await g.check(S, WRITE)).verdict).toBe('allow');
    expect(asked).toEqual([]);
  });
});

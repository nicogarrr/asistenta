import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyMail } from '../src/mail/triage.js';
import { MemoryStore } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

// asis-bugs-18: dos textos que van al modelo se cortaban a ciegas; con un emoji justo
// en el corte quedaba medio carácter suelto, y un proveedor de IA puede rechazar la
// petición entera como JSON inválido.
describe('textos para el modelo sin medio emoji', () => {
  it('memory history: el extracto de una conversación anterior', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem18-'));
    try {
      const sessions = {
        search: () => [
          {
            sessionId: 's1',
            title: 'Viaje',
            summary: '',
            snippet: `${'a'.repeat(219)}🛫 a Lisboa`,
            at: Date.parse('2026-10-20T10:00:00Z'),
          },
        ],
      };
      const tool = createMemoryTool(
        new MemoryStore(dir),
        () => 'telegram:main:1',
        undefined,
        undefined,
        sessions as never,
      );
      const r = await tool.execute('c1', { action: 'history', query: 'viaje' } as never);
      const text = (r.content[0] as { text: string }).text;
      expect(text).toContain('a'.repeat(219));
      expect(text).not.toMatch(LONE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clasificar correo: asunto y extracto que ve el modelo', async () => {
    const seen: Array<{ subject: string; snippet: string }> = [];
    await classifyMail(
      {
        from: 'Ana <ana@example.com>',
        subject: `${'s'.repeat(199)}🎉 fiesta`,
        text: `${'t'.repeat(299)}🎂 tarta`,
      } as never,
      {},
      async (input) => {
        seen.push(input);
        return null as never;
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.subject).not.toMatch(LONE);
    expect(seen[0]?.snippet).not.toMatch(LONE);
  });
});

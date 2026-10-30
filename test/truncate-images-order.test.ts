import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { truncateOldImages } = await import('../src/core/agent.js');

const img = (id: string) => ({ type: 'image', mimeType: 'image/png', data: id });
const msg = (role: string, content: unknown[]) =>
  ({ role, content, timestamp: 0 }) as unknown as AgentMessage;
const kept = (out: AgentMessage[]): string[] =>
  out.flatMap((m) =>
    ((m as unknown as { content: Array<{ type: string; data?: string }> }).content ?? [])
      .filter((b) => b.type === 'image')
      .map((b) => b.data ?? ''),
  );

describe('truncateOldImages conserva las capturas MÁS RECIENTES', () => {
  it('dentro de un mismo mensaje se descarta la primera, no la última', () => {
    const out = truncateOldImages([msg('toolResult', [img('1'), img('2'), img('3'), img('4')])], 3);
    expect(kept(out)).toEqual(['2', '3', '4']);
  });

  it('entre mensajes: la más antigua del mensaje viejo es la que sobra', () => {
    const out = truncateOldImages(
      [msg('user', [img('a'), img('b')]), msg('toolResult', [img('c'), img('d')])],
      3,
    );
    expect(kept(out)).toEqual(['b', 'c', 'd']);
  });

  it('no muta la entrada', () => {
    const content = [img('1'), img('2')];
    truncateOldImages([msg('toolResult', content)], 1);
    expect(content.map((b) => b.type)).toEqual(['image', 'image']);
  });
});

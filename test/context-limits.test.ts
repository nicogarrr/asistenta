import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import { PersonalAgent } from '../src/core/agent.js';
import type { Gate } from '../src/permissions.js';

const gate: Gate = { check: async () => ({ verdict: 'allow' }) } as unknown as Gate;

describe('attachContext', () => {
  const prev = process.env.OPENCODE_GO_API_KEY;
  beforeEach(() => {
    process.env.OPENCODE_GO_API_KEY = 'test-key-no-network';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCODE_GO_API_KEY;
    else process.env.OPENCODE_GO_API_KEY = prev;
  });

  it('keeps exactly one context note and puts the newest last', async () => {
    resetConfigForTests();
    const agent = await PersonalAgent.create(loadConfig(), [], gate, 'test');
    const user = { role: 'user', content: 'hola', timestamp: 1 } as never;
    agent.agent.state.messages = [user];
    agent.attachContext('<memory>a</memory> Ahora: 10:00');
    agent.attachContext('<memory>a</memory> Ahora: 10:01');
    const notes = agent.messages.filter((m) => m.role === 'system');
    expect(notes).toHaveLength(1);
    expect((notes[0] as { content: string }).content).toContain('10:01');
    expect(agent.messages[0]).toBe(user);
    expect(agent.messages.at(-1)).toBe(notes[0]);
  });

  it('ignores an empty note and keeps the previous one', async () => {
    resetConfigForTests();
    const agent = await PersonalAgent.create(loadConfig(), [], gate, 'test');
    agent.attachContext('uno');
    const before = agent.messages.length;
    agent.attachContext('   ');
    expect(agent.messages).toHaveLength(before);
    expect(
      agent.messages.filter((m) => (m as { content?: unknown }).content === 'uno'),
    ).toHaveLength(1);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capToolResultText } from '../src/core/agent.js';
import { DEFAULT_READ_LINES, MAX_READ_CHARS, readTool } from '../src/tools/fs.js';

describe('capToolResultText', () => {
  it('leaves a small result alone', () => {
    expect(capToolResultText([{ type: 'text', text: 'hola' }], 100)).toBeUndefined();
    expect(capToolResultText(undefined, 100)).toBeUndefined();
  });

  it('cuts oversized text, keeps head and tail, says how much was dropped', () => {
    const text = `INICIO${'x'.repeat(5000)}FINAL`;
    const out = capToolResultText([{ type: 'text', text }], 400);
    const got = (out?.[0] as { text: string }).text;
    expect(got.startsWith('INICIO')).toBe(true);
    expect(got.endsWith('FINAL')).toBe(true);
    expect(got).toContain(`${text.length - 400} caracteres omitidos`);
    expect(got.length).toBeLessThan(text.length / 5);
  });

  it('shares the budget across parts and never touches images', () => {
    const img = { type: 'image', data: 'AAAA' } as unknown as { type: string; text?: string };
    const out = capToolResultText(
      [{ type: 'text', text: 'a'.repeat(300) }, img, { type: 'text', text: 'b'.repeat(300) }],
      400,
    );
    expect(out?.[1]).toBe(img);
    expect((out?.[0] as { text: string }).text).toBe('a'.repeat(300));
    expect((out?.[2] as { text: string }).text).toContain('caracteres omitidos');
  });
});

describe('read default cap', () => {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-read-cap-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = async (file: string, args: Record<string, unknown> = {}) => {
    const r = await readTool.execute('c', { path: file, ...args } as never, undefined, undefined);
    return (r.content[0] as { text: string }).text;
  };

  it('returns one page of a long file and says how to continue', async () => {
    const f = join(dir, 'long.log');
    writeFileSync(f, Array.from({ length: 5000 }, (_, i) => `l${i}`).join('\n'));
    const text = await run(f);
    expect(text).toContain(`lines 1-${DEFAULT_READ_LINES} of 5000`);
    expect(text).toContain(`call read again with offset ${DEFAULT_READ_LINES + 1}`);
    expect(text).not.toContain('l2500');
  });

  it('bounds a one-line minified file', async () => {
    const f = join(dir, 'min.js');
    writeFileSync(f, 'y'.repeat(MAX_READ_CHARS * 3));
    const text = await run(f);
    expect(text.length).toBeLessThan(MAX_READ_CHARS + 500);
    expect(text).toContain('línea cortada');
  });

  it('still honours an explicit offset and limit', async () => {
    const f = join(dir, 'short.txt');
    writeFileSync(f, 'a\nb\nc\nd');
    const text = await run(f, { offset: 2, limit: 2 });
    expect(text).toContain('lines 2-3 of 4');
    expect(text).toContain('b\nc');
  });
});

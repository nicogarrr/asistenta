import { describe, expect, it } from 'vitest';
import {
  actionFingerprint,
  describeToolStart,
  detectLoop,
  shouldGuardFingerprint,
  truncateOldImages,
} from '../src/core/agent.js';
import { createDoneTool, extractDoneSummary } from '../src/tools/done.js';
import { stableStringify } from '../src/utils.js';

describe('done tool summary', () => {
  it('extracts a summary only from a real done result', () => {
    expect(
      extractDoneSummary({ content: [], details: { done: true, summary: '  Ya está.  ' } }),
    ).toBe('Ya está.');
    expect(extractDoneSummary({ details: { done: true, summary: '' } })).toBeNull();
    expect(extractDoneSummary({ details: { done: true } })).toBeNull();
    expect(extractDoneSummary({ content: [] })).toBeNull();
    expect(extractDoneSummary(null)).toBeNull();
  });

  it('ends the run as its only effect', async () => {
    const tool = createDoneTool();
    const result = await tool.execute(
      'call-1',
      { summary: 'Listo. Amazon está abierto en creatina.' },
      undefined,
      undefined,
    );
    expect(result.terminate).toBe(true);
    expect(result.content?.[0]).toMatchObject({ type: 'text' });
    expect(extractDoneSummary(result)).toBe('Listo. Amazon está abierto en creatina.');
  });
});

describe('stuck-loop detection', () => {
  it('fingerprints clicks without coordinates', () => {
    // (440,347) then (400,347) then (440,347) is one stuck behaviour, not three
    // different actions. This is the exact WhatsApp-search loop we hit in prod.
    expect(actionFingerprint('computer', { action: 'click', x: 440, y: 347 })).toBe(
      actionFingerprint('computer', { action: 'click', x: 400, y: 347 }),
    );
  });

  it('keeps typed text in the fingerprint', () => {
    // Filling a form types something different per field; a stuck loop retypes the
    // same thing. Dropping the text would false-positive on every form.
    expect(actionFingerprint('computer', { action: 'type', text: 'Nai' })).not.toBe(
      actionFingerprint('computer', { action: 'type', text: 'Hola' }),
    );
  });

  it('detects AAA repeats', () => {
    expect(detectLoop(['a', 'a'])).toBeNull();
    expect(detectLoop(['a', 'a', 'a'])).toBe('repeat');
    expect(detectLoop(['b', 'a', 'a', 'a'])).toBe('repeat');
  });

  it('detects ABAB cycles', () => {
    // click, type "Nai", click, type "Nai": the WhatsApp loop shape.
    const click = actionFingerprint('computer', { action: 'click', x: 1, y: 1 });
    const type = actionFingerprint('computer', { action: 'type', text: 'Nai' });
    expect(detectLoop([click, type, click, type])).toBe('cycle');
  });

  it('does not fire on genuine multi-step work', () => {
    const click = actionFingerprint('computer', { action: 'click', x: 1, y: 1 });
    const typeNai = actionFingerprint('computer', { action: 'type', text: 'Nai' });
    const typeHola = actionFingerprint('computer', { action: 'type', text: 'Hola' });
    const shot = actionFingerprint('computer', { action: 'screenshot' });
    expect(detectLoop([shot, click, typeNai, shot, click, typeHola])).toBeNull();
    expect(detectLoop([click, typeNai, click])).toBeNull();
  });

  it('tells keys apart and drags by direction', () => {
    // Tab, Enter, Tab, Enter while filling a form must not look like a loop.
    expect(actionFingerprint('computer', { action: 'key', key: 'Tab' })).not.toBe(
      actionFingerprint('computer', { action: 'key', key: 'Enter' }),
    );
    expect(actionFingerprint('computer', { action: 'drag', x: 0, y: 0, toX: 100, toY: 10 })).toBe(
      actionFingerprint('computer', { action: 'drag', x: 5, y: 5, toX: 200, toY: 0 }),
    );
    expect(
      actionFingerprint('computer', { action: 'drag', x: 0, y: 0, toX: 100, toY: 10 }),
    ).not.toBe(actionFingerprint('computer', { action: 'drag', x: 0, y: 0, toX: 10, toY: 100 }));
  });

  it('excludes observations from loop detection', () => {
    // Screenshots and moves interleave with every real step; counting them flags
    // healthy navigation (screenshot, click, screenshot, click) as a cycle.
    expect(shouldGuardFingerprint('computer', { action: 'screenshot' })).toBe(false);
    expect(shouldGuardFingerprint('computer', { action: 'move', x: 1, y: 2 })).toBe(false);
    expect(shouldGuardFingerprint('computer', { action: 'click', x: 1, y: 2 })).toBe(true);
    expect(shouldGuardFingerprint('computer', { action: 'type', text: 'x' })).toBe(true);
    expect(shouldGuardFingerprint('shell', { command: 'dir' })).toBe(true);
  });

  it('stringifies stably regardless of key order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});

describe('truncateOldImages', () => {
  const image = (id: string) => ({ type: 'image', mimeType: 'image/png', data: id });
  const text = (t: string) => ({ type: 'text', text: t });

  it('keeps the newest images and replaces older ones with placeholders', () => {
    const messages = [
      { role: 'user', content: [text('a'), image('1')], timestamp: 1 },
      { role: 'toolResult', content: [text('b'), image('2')], timestamp: 2 },
      { role: 'assistant', content: [text('c')], timestamp: 3 },
      { role: 'toolResult', content: [image('3'), image('4')], timestamp: 4 },
    ] as never[];
    const out = truncateOldImages(messages, 2) as Array<{
      content: Array<{ type: string; data?: string }>;
    }>;
    // Newest two images (4, 3) survive; 2 and 1 become placeholders.
    expect(JSON.stringify(out)).not.toContain('"data":"1"');
    expect(JSON.stringify(out)).not.toContain('"data":"2"');
    expect(JSON.stringify(out)).toContain('"data":"3"');
    expect(JSON.stringify(out)).toContain('"data":"4"');
    expect(JSON.stringify(out)).toContain('earlier screenshot omitted');
  });

  it('leaves text-only transcripts untouched', () => {
    const messages = [{ role: 'user', content: [text('hola')], timestamp: 1 }] as never[];
    expect(truncateOldImages(messages, 3)).toEqual(messages);
  });

  it('handles empty transcripts', () => {
    expect(truncateOldImages([], 3)).toEqual([]);
  });
});

describe('progress summaries', () => {
  it('never exposes raw tool arguments', () => {
    // The summary is what the user reads mid-task, so a command line, a typed card
    // number or a URL token must never appear in it. The assertions below check both
    // halves of that: the phrase is the natural Spanish one, and the secret is absent.
    const shell = describeToolStart('shell', { command: 'type C:\\secret\\card.txt' });
    expect(shell).toBe('ejecutando algo en el sistema');
    expect(shell).not.toContain('card.txt');

    const typed = describeToolStart('computer', { action: 'type', text: '4111111111111111' });
    expect(typed).toBe('escribiendo lo que pediste');
    expect(typed).not.toContain('4111');

    const fetched = describeToolStart('fetch', { url: 'https://example.com/a?token=secret' });
    expect(fetched).toBe('leyendo example.com');
    expect(fetched).not.toContain('token=secret');

    expect(describeToolStart('done', {})).toBe('terminando');
  });

  it('reads as a progress note rather than a debug trace', () => {
    // These strings go into "Sigo en ello, ahora <frase>", so they have to work as a
    // sentence a person would say, not as a log line. The first version said
    // "Sigo en ello: taking a screenshot." to a Spanish user.
    for (const [tool, args] of [
      ['computer', { action: 'screenshot' }],
      ['computer', { action: 'click' }],
      ['browser', { action: 'open' }],
      ['windows', { action: 'list' }],
      ['system', { action: 'volume' }],
    ]) {
      const phrase = describeToolStart(tool as string, args);
      expect(phrase.length).toBeGreaterThan(3);
      // No English leftovers and no underscores or camelCase.
      expect(phrase).not.toMatch(/[A-Z]/);
      expect(phrase).not.toMatch(/_/);
      expect(phrase).not.toMatch(/screenshot|running|taking|clicking/);
    }
  });
});

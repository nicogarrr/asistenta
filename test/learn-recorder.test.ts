// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que db.js/vault.js carguen paths.ts
import './factory-test-env.js';
import { describe, expect, it } from 'vitest';
import { LearnRecorder } from '../src/learn.js';

type Msg = { role: string; content: string };
class FakeAgent {
  messages: Msg[] = [];
  compactions = 0;
  say(role: string, content: string): Msg {
    const m = { role, content };
    this.messages.push(m);
    return m;
  }
  compact(): void {
    this.messages = [{ role: 'assistant', content: 'resumen' }, ...this.messages.slice(-2)];
    this.compactions++;
  }
}

describe('LearnRecorder anchors the recording to message identity', () => {
  it('summarises exactly the demonstrated segment', () => {
    const a = new FakeAgent();
    for (let i = 0; i < 4; i++) a.say('user', `old${i}`);
    const rec = new LearnRecorder();
    rec.start('c', 'x', 't', a);
    a.say('user', 'demo1');
    a.say('assistant', 'demo2');
    const r = rec.end('c', 't', a);
    expect(r.ok && r.segment.map((m) => (m as Msg).content)).toEqual(['demo1', 'demo2']);
  });
  it('auditor case: compaction shrinks then growth passes the old index - refused', () => {
    const a = new FakeAgent();
    for (let i = 0; i < 10; i++) a.say('user', `old${i}`);
    const rec = new LearnRecorder();
    rec.start('c', 'x', 't', a);
    a.say('user', 'demo');
    a.compact();
    for (let i = 0; i < 7; i++) a.say('user', `new${i}`);
    expect(a.messages.length).toBeGreaterThanOrEqual(10);
    expect(rec.end('c', 't', a)).toMatchObject({ ok: false, reason: 'unanchored' });
  });
  it('empty-history start plus a compaction is refused too', () => {
    const a = new FakeAgent();
    const rec = new LearnRecorder();
    rec.start('c', 'x', 't', a);
    a.say('user', 'demo');
    a.compact();
    expect(rec.end('c', 't', a)).toMatchObject({ ok: false, reason: 'unanchored' });
  });
  it('a re-appended context note does not shift the segment', () => {
    const a = new FakeAgent();
    a.say('user', 'old');
    const note = a.say('system', 'ctx1');
    const rec = new LearnRecorder();
    rec.start('c', 'x', 't', a);
    a.messages = a.messages.filter((m) => m !== note);
    a.say('user', 'demo');
    a.say('system', 'ctx2');
    const r = rec.end('c', 't', a);
    expect(r.ok && r.segment.map((m) => (m as Msg).content)).toEqual(['demo', 'ctx2']);
  });
  it('another thread keeps the recording; a rebuilt agent is refused; none is none', () => {
    const a = new FakeAgent();
    a.say('user', 'old');
    const rec = new LearnRecorder();
    expect(rec.end('c', 't', a)).toMatchObject({ ok: false, reason: 'none' });
    rec.start('c', 'x', 't', a);
    expect(rec.end('c', 'other', a)).toMatchObject({
      ok: false,
      reason: 'other-thread',
      name: 'x',
    });
    expect(rec.end('c', 't', new FakeAgent())).toMatchObject({ ok: false, reason: 'unanchored' });
    expect(rec.end('c', 't', a)).toMatchObject({ ok: false, reason: 'none' });
  });
});

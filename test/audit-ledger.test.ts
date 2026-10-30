import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendCallAudit, canonicalJson, verifyCallAudit } from '../src/audit/calls.js';
import { ActionLog } from '../src/audit/log.js';
import { readCallAudit } from '../src/audit/query.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-audit-'));
  file = join(dir, 'calls.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('call ledger: an optional field passed as undefined', () => {
  it('still verifies (the agent passes ms: undefined when a call has no recorded start)', () => {
    appendCallAudit(
      {
        callId: 'c1',
        tool: 'shell',
        argsHash: 'a',
        verdict: 'allow',
        isError: false,
        ms: 12,
      },
      file,
    );
    appendCallAudit(
      {
        callId: 'c2',
        tool: 'shell',
        argsHash: 'b',
        verdict: 'allow',
        isError: false,
        ms: undefined,
      },
      file,
    );
    appendCallAudit(
      {
        callId: 'c3',
        tool: 'mail',
        argsHash: 'c',
        verdict: 'deny',
        reason: undefined,
      },
      file,
    );
    expect(verifyCallAudit(file)).toEqual({ ok: true, entries: 3 });
    expect(readCallAudit(file).map((l) => l.callId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('does not write the undefined field to disk', () => {
    appendCallAudit(
      {
        callId: 'c1',
        tool: 'shell',
        argsHash: 'a',
        verdict: 'allow',
        ms: undefined,
      },
      file,
    );
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    expect('ms' in line).toBe(false);
  });
});

describe('call ledger: ledgers written before the fix', () => {
  /** What the old writer did: hash the absent field as null, write the line without it. */
  function legacyLine(
    prev: string,
    fields: Record<string, unknown>,
    hashedAsNull: string[],
  ): string {
    const base: Record<string, unknown> = { v: 1, ts: '2026-10-30T10:00:00.000Z', prev, ...fields };
    const hashed: Record<string, unknown> = { ...base };
    for (const key of hashedAsNull) hashed[key] = null;
    const h = createHash('sha256')
      .update(`${prev}\n${canonicalJson(hashed)}`)
      .digest('hex');
    return JSON.stringify({ ...base, h });
  }

  it('an untouched old ledger verifies instead of reading as corrupt', () => {
    const first = legacyLine(
      '',
      { callId: 'c1', tool: 'shell', argsHash: 'a', verdict: 'allow', isError: false },
      ['ms'],
    );
    const h1 = JSON.parse(first).h as string;
    const second = legacyLine(h1, { callId: 'c2', tool: 'mail', argsHash: 'b', verdict: 'deny' }, [
      'reason',
    ]);
    writeFileSync(file, `${first}\n${second}\n`);
    expect(verifyCallAudit(file)).toEqual({ ok: true, entries: 2 });
  });

  it('tampering is still detected: an edited value or a removed field breaks the chain', () => {
    appendCallAudit(
      {
        callId: 'c1',
        tool: 'shell',
        argsHash: 'a',
        verdict: 'deny',
        reason: 'sin permiso',
      },
      file,
    );
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('"verdict":"deny"', '"verdict":"allow"'));
    expect(verifyCallAudit(file).ok).toBe(false);
    const line = JSON.parse(original.trim());
    delete line.reason;
    writeFileSync(file, `${JSON.stringify(line)}\n`);
    expect(verifyCallAudit(file)).toMatchObject({ ok: false, brokenAt: 1 });
  });
});

describe('ActionLog.recent', () => {
  it('a limit of 0 (or less) returns nothing, not the whole log', () => {
    const actions = new ActionLog({ file: join(dir, 'actions.jsonl') });
    for (let i = 0; i < 3; i++) actions.record({ actor: 'agente', action: `a${i}`, result: 'ok' });
    expect(actions.recent(0)).toEqual([]);
    expect(actions.recent(-5)).toEqual([]);
    expect(actions.recent(2).map((e) => e.action)).toEqual(['a1', 'a2']);
    expect(actions.recent(10).map((e) => e.action)).toEqual(['a0', 'a1', 'a2']);
  });

  it('skips junk lines and reads the rotated backup first', () => {
    const path = join(dir, 'actions.jsonl');
    writeFileSync(
      `${path}.1`,
      `${JSON.stringify({ ts: '2026-10-30T08:00:00.000Z', actor: 'a', action: 'viejo', result: 'ok' })}\n`,
    );
    writeFileSync(
      path,
      `no es json\n{"ts":1}\n${JSON.stringify({ ts: '2026-10-30T09:00:00.000Z', actor: 'a', action: 'nuevo', result: 'raro' })}\n${JSON.stringify({ ts: '2026-10-30T09:30:00.000Z', actor: 'a', action: 'nuevo', result: 'error', target: 'x', detail: 'y' })}\n`,
    );
    const actions = new ActionLog({ file: path });
    expect(actions.recent(10).map((e) => [e.action, e.result])).toEqual([
      ['viejo', 'ok'],
      ['nuevo', 'error'],
    ]);
    expect(actions.recent(10, { result: 'error' })).toHaveLength(1);
  });
});

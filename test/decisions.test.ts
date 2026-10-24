// Decision ledger: producer -> persist -> prompt context, with negative cases.
// These test context construction and validation, not LLM behaviour.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AuthenticInbound, DecisionLedger } from '../src/memory/decisions.js';
import { WorkstreamStore } from '../src/memory/workstreams.js';

const SCOPE = 'telegram:main:1#main';
let ws: WorkstreamStore;
let ledger: DecisionLedger;
let wsId: string;

const msg = (text: string, over: Partial<AuthenticInbound> = {}): AuthenticInbound => ({
  messageId: 'm1',
  userId: 'u1',
  text,
  receivedAt: '2026-10-24T10:00:00Z',
  authorised: true,
  scope: SCOPE,
  ...over,
});

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  ws = new WorkstreamStore({ db });
  ledger = new DecisionLedger(db, ws);
  wsId = ws.create(SCOPE, 'cena', 'cenar con amigos');
});

describe('decision ledger', () => {
  it('confirmed decision with a verified quote reaches the prompt index with provenance kept', () => {
    const r = ledger.recordConfirmed(
      wsId,
      'sitio: casa de Ana',
      'lo hacemos en casa de Ana',
      msg('vale, lo hacemos en casa de Ana el sábado'),
    );
    expect(r.ok).toBe(true);
    expect(ws.index(SCOPE)).toContain('resuelto: sitio: casa de Ana');
    const d = ledger.list(wsId)[0]!;
    expect(d.messageId).toBe('m1');
    expect(d.userId).toBe('u1');
    expect(d.quote).toBe('lo hacemos en casa de Ana');
  });

  it('rejects an invented quote', () => {
    const r = ledger.recordConfirmed(
      wsId,
      'sitio: casa de Ana',
      'quedamos en casa de Ana',
      msg('no sé dónde'),
    );
    expect(r.ok).toBe(false);
    expect(ws.index(SCOPE)).not.toContain('resuelto:');
  });

  it('rejects a message from another conversation, an unauthorised author and no message', () => {
    expect(
      ledger.recordConfirmed(wsId, 's', 'casa de Ana', msg('casa de Ana', { scope: 'otro#main' }))
        .ok,
    ).toBe(false);
    expect(
      ledger.recordConfirmed(wsId, 's', 'casa de Ana', msg('casa de Ana', { authorised: false }))
        .ok,
    ).toBe(false);
    expect(ledger.recordConfirmed(wsId, 's', 'casa de Ana', undefined).ok).toBe(false);
    expect(ws.index(SCOPE)).not.toContain('resuelto:');
  });

  it('tentative notes never appear as resolved', () => {
    ledger.recordTentative(wsId, 'quizá en casa de Ana');
    expect(ws.index(SCOPE)).not.toContain('resuelto:');
    expect(ws.index(SCOPE)).not.toContain('casa de Ana');
    expect(ledger.list(wsId, 'tentative')).toHaveLength(1);
  });

  it('a correction supersedes the old decision', () => {
    const a = ledger.recordConfirmed(wsId, 'hora: 21:00', 'a las 21:00', msg('a las 21:00'));
    if (!a.ok) throw new Error('setup');
    ledger.recordConfirmed(
      wsId,
      'hora: 22:00',
      'mejor a las 22:00',
      msg('mejor a las 22:00', { messageId: 'm2' }),
      a.id,
    );
    const idx = ws.index(SCOPE);
    expect(idx).toContain('hora: 22:00');
    expect(idx).not.toContain('21:00');
  });

  it('retract removes it from the prompt; wrong scope cannot retract', () => {
    const a = ledger.recordConfirmed(wsId, 'hora: 21:00', 'a las 21:00', msg('a las 21:00'));
    if (!a.ok) throw new Error('setup');
    expect(ledger.retract(a.id, 'otro#main')).toBe(false);
    expect(ws.index(SCOPE)).toContain('21:00');
    expect(ledger.retract(a.id, SCOPE)).toBe(true);
    expect(ws.index(SCOPE)).not.toContain('21:00');
  });

  it('rejects too-short quotes', () => {
    expect(ledger.recordConfirmed(wsId, 's', 'sí', msg('sí')).ok).toBe(false);
  });
});

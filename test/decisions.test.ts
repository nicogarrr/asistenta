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
    expect(ws.index(SCOPE)).toContain(
      'dicho por el usuario (intención no verificada; confirma antes de actuar si importa): sitio: casa de Ana',
    );
    const d = ledger.list(wsId)[0];
    if (!d) throw new Error('setup');
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
    expect(ws.index(SCOPE)).not.toContain('si importa):');
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
    expect(ws.index(SCOPE)).not.toContain('si importa):');
  });

  it('tentative notes never appear as resolved', () => {
    ledger.recordTentative(wsId, 'quizá en casa de Ana');
    expect(ws.index(SCOPE)).not.toContain('si importa):');
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

  it('rejects too-short quotes (old)', () => {
    expect(ledger.recordConfirmed(wsId, 's', 'sí vale', msg('sí vale')).ok).toBe(false);
  });

  it('refuses a truncated quote of a negation, a hypothesis, a question and forwarded text', () => {
    const cases: Array<[string, string]> = [
      ['quedamos en casa de Ana', 'no quiero que quedemos en casa de Ana'],
      ['a las 21:00 en mi casa', 'quizá a las 21:00 en mi casa'],
      ['hacerlo en casa de Ana', '¿podemos hacerlo en casa de Ana?'],
      ['cenamos en casa de Ana', 'Ana dice que cenamos en casa de Ana'],
      ['cenamos en casa de Ana', 'Reenviado: cenamos en casa de Ana'],
      ['cenamos en casa de Ana', 'si llueve cenamos en casa de Ana'],
    ];
    for (const [quote, text] of cases) {
      expect(ledger.recordConfirmed(wsId, 'sitio: casa de Ana', quote, msg(text)).ok, text).toBe(
        false,
      );
    }
    expect(ws.index(SCOPE)).not.toContain('si importa):');
  });

  it('accepts a plain affirmative sentence', () => {
    expect(
      ledger.recordConfirmed(
        wsId,
        'sitio: casa de Ana',
        'cenamos en casa de Ana',
        msg('Vale. Cenamos en casa de Ana.'),
      ).ok,
    ).toBe(true);
  });

  it('supersede must belong to the same workstream and does not touch the other front', () => {
    const other = ws.create(SCOPE, 'otro plan', 'viaje');
    const a = ledger.recordConfirmed(
      wsId,
      'hora: 21:00',
      'a las 21:00 cenamos',
      msg('a las 21:00 cenamos'),
    );
    if (!a.ok) throw new Error('setup');
    const r = ledger.recordConfirmed(
      other,
      'hora: 22:00',
      'salimos a las 22:00',
      msg('salimos a las 22:00'),
      a.id,
    );
    expect(r.ok).toBe(false);
    expect(ws.index(SCOPE)).toContain('hora: 21:00');
    expect(ledger.list(wsId, 'confirmed')).toHaveLength(1);
  });

  it('render keeps quote and date, labels intent as unverified, and drops whole items not cut text', () => {
    const a = ledger.recordConfirmed(
      wsId,
      'hora: 21:00',
      'cenamos a las 21:00',
      msg('Vale, cenamos a las 21:00.'),
    );
    expect(a.ok).toBe(true);
    const idx = ws.index(SCOPE);
    expect(idx).toContain('intención no verificada');
    expect(idx).toContain('«cenamos a las 21:00»');
    expect(idx).toContain('2026-10-24');
    // many decisions: no item is cut in half, the rest is counted
    for (let i = 0; i < 12; i++) {
      ledger.recordConfirmed(
        wsId,
        `punto ${i} de la lista larga`,
        `acordamos el punto ${i}`,
        msg(`Acordamos el punto ${i}.`, { messageId: `x${i}` }),
      );
    }
    const long = ws.index(SCOPE);
    expect(long).toMatch(/\+\d+ más \(ver decision listar\)/);
    for (const part of long.split(' | ')) {
      if (part.includes('«')) expect(part).toContain('»');
    }
  });

  it('a single very long item is marked as cut, never shown as complete', () => {
    const long = 'x'.repeat(700);
    ledger.recordConfirmed(
      wsId,
      `plan ${long}`,
      'acordamos el plan largo',
      msg('Acordamos el plan largo.'),
    );
    const idx = ws.index(SCOPE);
    expect(idx).toContain('[recortado: ver decision listar]');
    expect(idx).not.toContain(long);
  });

  it("a literal '|' in summary or quote does not create fake items", () => {
    ledger.recordConfirmed(wsId, 'a | b', 'acordamos a | b', msg('Acordamos a | b.'));
    const idx = ws.index(SCOPE);
    expect(idx).toContain('a ¦ b');
    expect(idx).not.toMatch(/ \| b/);
  });
});

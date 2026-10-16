import { describe, expect, it } from 'vitest';
import { approvalReasonSpanish, formatApproval } from '../src/approval-text.js';

describe('Spanish reasons without changing authority', () => {
  it.each([
    ['touches money or credentials', 'dinero'],
    ['runs a shell command', 'terminal'],
    ['drives the desktop', 'escritorio'],
    ['pre-payment stage of a purchase flow', 'pago'],
    ['not on the allow list', 'permitidas'],
  ])('translates the known reason %s', (reason, word) => {
    expect(approvalReasonSpanish(reason)).toContain(word);
  });
  it('keeps unknown and already Spanish reasons verbatim', () => {
    for (const reason of ['Confirmar la compra de prueba', 'owner-specific reason', ''])
      expect(approvalReasonSpanish(reason)).toBe(reason);
  });
  it('changes only prose, never the shell operation or original args', () => {
    const call = {
      tool: 'shell',
      args: { command: "printf '%s' 'runs a shell command'" },
      actor: 'test',
    };
    const original = structuredClone(call);
    const rendered = formatApproval(call, 'runs a shell command');
    expect(rendered.question).toContain(call.args.command);
    expect(rendered.question).toContain('Motivo: Ejecuta un comando de terminal');
    expect(call).toEqual(original);
  });
});

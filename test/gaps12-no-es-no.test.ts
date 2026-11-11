import { describe, expect, it } from 'vitest';
import { DENIED_AGAIN_REASON, Gate } from '../src/permissions.js';

const call = (command: string) => ({ tool: 'shell', args: { command }, actor: 'owner' });

describe('«No» es no hasta tu próximo mensaje (Grok Bot: Deny no vuelve a preguntar)', () => {
  it('la misma acción denegada no vuelve a preguntar en el mismo turno', async () => {
    const asked: string[] = [];
    const gate = new Gate({
      approver: (c) => {
        asked.push(String(c.args.command));
        return false;
      },
    });
    gate.registerSession('s');
    const first = await gate.check('s', call('rm -rf C:\\temp\\x') as never);
    expect(first.verdict).toBe('deny');
    const again = await gate.check('s', call('rm -rf C:\\temp\\x') as never);
    expect(again.verdict).toBe('deny');
    expect(again.reason).toBe(DENIED_AGAIN_REASON);
    // Solo se le preguntó una vez.
    expect(asked).toEqual(['rm -rf C:\\temp\\x']);
  });

  it('otra acción distinta sí pregunta; y tras su próximo mensaje (fin del turno) vuelve a preguntar', async () => {
    let answer = false;
    const asked: string[] = [];
    const gate = new Gate({
      approver: (c) => {
        asked.push(String(c.args.command));
        return answer;
      },
    });
    gate.registerSession('s');
    await gate.check('s', call('del a.txt') as never);
    await gate.check('s', call('del b.txt') as never);
    expect(asked).toEqual(['del a.txt', 'del b.txt']);
    gate.clearSession('s');
    gate.registerSession('s');
    answer = true;
    const d = await gate.check('s', call('del a.txt') as never);
    expect(d.verdict).toBe('allow');
    expect(asked).toEqual(['del a.txt', 'del b.txt', 'del a.txt']);
  });

  it('cada conversación lleva su propia cuenta', async () => {
    const asked: string[] = [];
    const gate = new Gate({
      approver: (_c) => {
        asked.push('x');
        return false;
      },
    });
    gate.registerSession('a');
    gate.registerSession('b');
    await gate.check('a', call('del z.txt') as never);
    await gate.check('b', call('del z.txt') as never);
    expect(asked).toHaveLength(2);
  });
});

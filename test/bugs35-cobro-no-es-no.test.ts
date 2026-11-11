import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import { checkoutStageOf } from '../src/tools/checkout.js';

// bugs-35: revisión del cambio de gaps-12 (#2326) en test/commerce.test.ts, que pasó de
// «4 preguntas» a «3» en un cobro rechazado dos veces en el mismo turno. Es el
// comportamiento buscado (no se repregunta lo ya denegado en este mensaje) y no rebaja la
// seguridad: el segundo intento sigue siendo «deny» y no se compra nada. Lo que el test
// viejo cubría de paso, «the run can be retried», queda aquí fijado: en el siguiente
// mensaje de Nico (clearSession) se vuelve a preguntar, y un «no» nunca pasa a ser un «sí».

const charge = { action: 'confirm', item: 'tren', price: '45,20' };

function gateWith(answers: boolean[]) {
  let asked = 0;
  const gate = new Gate({
    fullControl: true,
    allowPayments: true,
    allowUntilPayment: true,
    stageOf: checkoutStageOf,
    approver: () => answers[asked++] ?? false,
  });
  return { gate, asked: () => asked };
}

describe('cobro rechazado: «no es no» en el turno, y se puede reintentar en el siguiente', () => {
  it('mismo turno: una sola pregunta, los dos intentos denegados', async () => {
    const g = gateWith([false, true]);
    for (const _ of [1, 2]) {
      const v = await g.gate.check('s1', { tool: 'checkout', args: charge, actor: 'u' });
      expect(v.verdict).toBe('deny');
    }
    // El «sí» que habría dado a una segunda pregunta no se usa: no se le preguntó.
    expect(g.asked()).toBe(1);
  });

  it('siguiente mensaje (clearSession): vuelve a preguntar; el «sí» de ahora vale, el «no» de antes no', async () => {
    const g = gateWith([false, true]);
    expect((await g.gate.check('s1', { tool: 'checkout', args: charge, actor: 'u' })).verdict).toBe(
      'deny',
    );
    g.gate.clearSession('s1');
    expect((await g.gate.check('s1', { tool: 'checkout', args: charge, actor: 'u' })).verdict).toBe(
      'allow',
    );
    expect(g.asked()).toBe(2);
  });

  it('otro cobro distinto en el mismo turno sí se pregunta', async () => {
    const g = gateWith([false, false]);
    await g.gate.check('s1', { tool: 'checkout', args: charge, actor: 'u' });
    const otro = { ...charge, price: '19,90', item: 'bus' };
    expect((await g.gate.check('s1', { tool: 'checkout', args: otro, actor: 'u' })).verdict).toBe(
      'deny',
    );
    expect(g.asked()).toBe(2);
  });
});

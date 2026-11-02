import { describe, expect, it, vi } from 'vitest';
import { createPurchaseApprovals } from '../src/daemon/purchase-approvals.js';

// Un «sí» a una compra se recuerda el resto del turno para no preguntar dos veces lo
// mismo. Pero si el turno ya está cortado (/stop, tiempo agotado) cuando la misma
// confirmación vuelve a llegar, antes se devolvía ese «sí» recordado y la herramienta
// abría la pantalla de pago después del /stop. Ahora queda denegada. Solo deniega.
describe('compra recordada y turno cortado', () => {
  it('con el turno cortado, un «sí» recordado no vale', async () => {
    const human = vi.fn(async () => true);
    const p = createPurchaseApprovals();
    await expect(p.ask('t', 'checkout:confirm', '¿Pagar 20 €?', human)).resolves.toBe(true);
    const stop = new AbortController();
    stop.abort();
    await expect(p.ask('t', 'checkout:confirm', '¿Pagar 20 €?', human, stop.signal)).resolves.toBe(
      false,
    );
    expect(human).toHaveBeenCalledTimes(1);
  });

  it('sin cortar, el «sí» recordado sigue valiendo (no se pregunta dos veces)', async () => {
    const human = vi.fn(async () => true);
    const p = createPurchaseApprovals();
    const live = new AbortController();
    await p.ask('t', 'checkout:confirm', 'x', human, live.signal);
    await expect(p.ask('t', 'checkout:confirm', 'x', human, live.signal)).resolves.toBe(true);
    expect(human).toHaveBeenCalledTimes(1);
  });

  it('un «no» recordado sigue siendo «no» con o sin corte', async () => {
    const human = vi.fn(async () => false);
    const p = createPurchaseApprovals();
    await p.ask('t', 'pay', 'x', human);
    const stop = new AbortController();
    stop.abort();
    await expect(p.ask('t', 'pay', 'x', human, stop.signal)).resolves.toBe(false);
    await expect(p.ask('t', 'pay', 'x', human)).resolves.toBe(false);
    expect(human).toHaveBeenCalledTimes(1);
  });
});

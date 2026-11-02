import { describe, expect, it, vi } from 'vitest';
import { createPurchaseApprovals } from '../src/daemon/purchase-approvals.js';

// Dos preguntas de compra idénticas a la vez en un turno (p. ej. dos llamadas paralelas
// a la misma compra): se pregunta una sola vez y la segunda nunca se aprueba sola.
// Comparte un «no»; con un «sí» la segunda queda denegada (sería un segundo cargo con
// una sola confirmación). Solo deniega antes; nada se permite que antes se denegara.
function deferred() {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('preguntas de compra idénticas a la vez', () => {
  it('se pregunta una sola vez y la segunda queda denegada aunque digas que sí', async () => {
    const d = deferred();
    const human = vi.fn(() => d.promise);
    const p = createPurchaseApprovals();
    const a = p.ask('t', 'checkout:confirm', '¿Pagar 20 €?', human);
    const b = p.ask('t', 'checkout:confirm', '¿Pagar 20 €?', human);
    await Promise.resolve();
    expect(human).toHaveBeenCalledTimes(1);
    d.resolve(true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(false);
    expect(human).toHaveBeenCalledTimes(1);
  });

  it('con un «no» las dos quedan denegadas y solo se pregunta una vez', async () => {
    const d = deferred();
    const human = vi.fn(() => d.promise);
    const p = createPurchaseApprovals();
    const a = p.ask('t', 'pay', 'x', human);
    const b = p.ask('t', 'pay', 'x', human);
    d.resolve(false);
    await expect(Promise.all([a, b])).resolves.toEqual([false, false]);
    expect(human).toHaveBeenCalledTimes(1);
  });

  it('si la primera pregunta falla, la segunda también queda denegada', async () => {
    const human = vi.fn(() => Promise.reject(new Error('telegram caído')));
    const p = createPurchaseApprovals();
    const a = p.ask('t', 'pay', 'x', human);
    const b = p.ask('t', 'pay', 'x', human);
    await expect(a).rejects.toThrow('telegram caído');
    await expect(b).resolves.toBe(false);
    expect(human).toHaveBeenCalledTimes(1);
  });

  it('la segunda con su turno cortado sale denegada sin esperar a la primera', async () => {
    const d = deferred();
    const human = vi.fn(() => d.promise);
    const p = createPurchaseApprovals();
    const ctl = new AbortController();
    const a = p.ask('t', 'pay', 'x', human);
    const b = p.ask('t', 'pay', 'x', human, ctl.signal);
    ctl.abort();
    await expect(b).resolves.toBe(false);
    d.resolve(true);
    await expect(a).resolves.toBe(true);
  });

  it('preguntas distintas o de otro hilo a la vez siguen preguntando cada una', async () => {
    const human = vi.fn(async () => true);
    const p = createPurchaseApprovals();
    const r = await Promise.all([
      p.ask('t', 'pay', '¿Pagar 20 €?', human),
      p.ask('t', 'pay', '¿Pagar 35 €?', human),
      p.ask('u', 'pay', '¿Pagar 20 €?', human),
    ]);
    expect(r).toEqual([true, true, true]);
    expect(human).toHaveBeenCalledTimes(3);
  });

  it('una vez respondida, la misma pregunta luego en el turno reutiliza la respuesta (gate + herramienta)', async () => {
    const human = vi.fn(async () => true);
    const p = createPurchaseApprovals();
    await expect(p.ask('t', 'pay', 'x', human)).resolves.toBe(true);
    await expect(p.ask('t', 'pay', 'x', human)).resolves.toBe(true);
    expect(human).toHaveBeenCalledTimes(1);
  });
});

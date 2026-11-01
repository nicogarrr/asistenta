import { describe, expect, it, vi } from 'vitest';
import { createPurchaseApprovals } from '../src/daemon/purchase-approvals.js';

// Movido de cli.ts sin cambio: la misma compra no pregunta dos veces en un turno, dos
// compras distintas sí, una negativa también se recuerda, y el fin del turno de un hilo
// borra solo lo de ese hilo.
describe('createPurchaseApprovals', () => {
  it('la misma pregunta en el mismo turno se hace una sola vez (gate + herramienta)', async () => {
    const human = vi.fn(async () => true);
    const p = createPurchaseApprovals();
    await expect(p.ask('tg:main:1#principal', 'pay', '¿Pagar 20 €?', human)).resolves.toBe(true);
    await expect(p.ask('tg:main:1#principal', 'pay', '¿Pagar 20 €?', human)).resolves.toBe(true);
    expect(human).toHaveBeenCalledTimes(1);
    expect(human).toHaveBeenCalledWith('¿Pagar 20 €?');
  });

  it('dos compras distintas en un turno preguntan dos veces', async () => {
    const human = vi.fn(async () => true);
    const p = createPurchaseApprovals();
    await p.ask('t', 'pay', '¿Pagar 20 €?', human);
    await p.ask('t', 'pay', '¿Pagar 35 €?', human);
    expect(human).toHaveBeenCalledTimes(2);
  });

  it('un «no» también se recuerda: la segunda capa no vuelve a preguntar', async () => {
    const human = vi.fn(async () => false);
    const p = createPurchaseApprovals();
    await expect(p.ask('t', 'pay', 'x', human)).resolves.toBe(false);
    await expect(p.ask('t', 'pay', 'x', human)).resolves.toBe(false);
    expect(human).toHaveBeenCalledTimes(1);
  });

  it('forgetThread borra solo el hilo que termina', async () => {
    const human = vi.fn(async () => true);
    const p = createPurchaseApprovals();
    await p.ask('a', 'pay', 'x', human);
    await p.ask('b', 'pay', 'x', human);
    p.forgetThread('a');
    await p.ask('a', 'pay', 'x', human);
    await p.ask('b', 'pay', 'x', human);
    expect(human).toHaveBeenCalledTimes(3);
  });

  it('cli.ts usa el módulo (no queda un Map de respuestas propio)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain('createPurchaseApprovals(');
    expect(src).not.toContain('purchaseAnswers');
  });
});

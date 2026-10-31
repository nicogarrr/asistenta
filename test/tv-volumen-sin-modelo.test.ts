/**
 * Nico (31/10 01:05): «Baja el volumen de la tv» acabó en «Fallo: fetch failed» porque el
 * modelo no respondía. Con /tv (o sus botones) la orden va por la vía rápida, sin modelo.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';
import { tvChatCommand } from '../src/tv/tv-chat-command.js';

const ORDERS = [
  'Baja el volumen de la tv',
  'baja el volumen',
  'Baja el volumen de la tele',
  'sube el volumen de la tv',
];

describe('órdenes de volumen por la vía rápida, sin el modelo', () => {
  it.each(ORDERS)('«%s» se entiende sin preguntar al modelo', (text) => {
    expect(parseTvCommand(text)).toMatchObject({ action: 'volumeStep' });
  });

  it('/tv baja el volumen de la tv llega a la tele sin pasar por el modelo', async () => {
    const run = vi.fn(async (_text: string) => '');
    const reply = await tvChatCommand('Baja el volumen de la tv', { isOwner: true, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe('Baja el volumen de la tv');
    expect(reply).not.toMatch(/Fallo|fetch failed/);
  });
});

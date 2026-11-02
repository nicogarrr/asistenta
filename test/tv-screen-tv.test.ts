/**
 * /screen tv: la captura es de la TELE (por SSAP), nunca la pantalla del PC.
 * Frame con contenido -> foto. Frame casi vacio (negro, casi siempre DRM) ->
 * NO se manda foto: texto claro + estado en vivo como alternativa.
 */
import { describe, expect, it } from 'vitest';
import { screenTvBlankText, screenTvCapture } from '../src/tv/screen-tv.js';
import type { TvStatus } from '../src/tv/status.js';
import { SUSPECT_BLANK_BYTES } from '../src/tools/tv.js';

const grande = Buffer.alloc(SUSPECT_BLANK_BYTES + 1, 1);
const negro = Buffer.alloc(9_000, 0);

const statusVivo: TvStatus = {
  reachable: true,
  power: 'encendida',
  powerState: 'Active',
  appId: 'netflix',
  showing: 'Netflix',
  input: null,
  volume: 13,
  muted: false,
  attempts: 1,
  checkedAt: '2026-11-02T20:00:00Z',
};

describe('/screen tv', () => {
  it('frame con contenido: devuelve la foto', async () => {
    const res = await screenTvCapture({
      shot: async () => ({ image: grande, mimeType: 'image/jpeg' }),
    });
    expect(res.kind).toBe('photo');
    if (res.kind === 'photo') expect(res.image.length).toBe(grande.length);
  });

  it('frame negro: NO foto; texto claro de DRM + estado en vivo', async () => {
    let statusPedido = 0;
    const res = await screenTvCapture({
      shot: async () => ({ image: negro, mimeType: 'image/jpeg' }),
      status: async () => {
        statusPedido += 1;
        return statusVivo;
      },
    });
    expect(res.kind).toBe('text');
    if (res.kind !== 'text') return;
    expect(res.text).toContain('negro');
    expect(res.text).toContain('DRM');
    expect(res.text).toContain('Netflix');
    expect(statusPedido).toBe(1);
    // Honestidad: el tamaño no prueba DRM.
    expect(res.text).toContain('pantalla muy oscura');
  });

  it('frame negro y estado que falla: el texto sale igualmente, sin estado', async () => {
    const res = await screenTvCapture({
      shot: async () => ({ image: negro, mimeType: 'image/jpeg' }),
      status: async () => {
        throw new Error('tele lenta');
      },
    });
    expect(res.kind).toBe('text');
    if (res.kind !== 'text') return;
    expect(res.text).toContain('negro');
    expect(res.text).not.toContain('La tele esta encendida');
  });

  it('sin status en la instalacion: tambien funciona', async () => {
    const res = await screenTvCapture({
      shot: async () => ({ image: negro, mimeType: 'image/jpeg' }),
    });
    expect(res.kind).toBe('text');
  });

  it('el texto no se inventa: dice que no puede afirmar el motivo', () => {
    const t = screenTvBlankText(null);
    expect(t).toContain('Casi siempre');
    expect(t).not.toContain('seguro que es el DRM');
  });
});

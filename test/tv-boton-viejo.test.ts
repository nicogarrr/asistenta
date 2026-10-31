import { describe, expect, it } from 'vitest';
import {
  isTooOldButtonError,
  STALE_TV_BUTTON_WINDOW_MS,
  tvButtonMaybeStale,
} from '../src/tv/stale-order.js';

describe('botón del mando pulsado con Asistenta apagada', () => {
  const connected = 1_000_000;
  it('solo puede ser viejo si el teclado es de antes de conectar y acabamos de conectar', () => {
    expect(tvButtonMaybeStale(connected - 60_000, connected, connected + 1_000)).toBe(true);
    expect(tvButtonMaybeStale(connected + 1, connected, connected + 1_000)).toBe(false);
    expect(
      tvButtonMaybeStale(connected - 60_000, connected, connected + STALE_TV_BUTTON_WINDOW_MS + 1),
    ).toBe(false);
    expect(tvButtonMaybeStale(undefined, connected)).toBe(false);
    expect(tvButtonMaybeStale(connected - 1, undefined)).toBe(false);
  });
  it('reconoce el «query is too old» de Telegram y nada más', () => {
    expect(
      isTooOldButtonError({
        description:
          'Bad Request: query is too old and response timeout expired or query ID is invalid',
      }),
    ).toBe(true);
    expect(isTooOldButtonError(new Error('Bad Request: query ID is invalid'))).toBe(true);
    expect(isTooOldButtonError(new Error('fetch failed'))).toBe(false);
    expect(isTooOldButtonError(null)).toBe(false);
  });
});

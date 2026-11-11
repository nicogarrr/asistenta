import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import {
  chatReplyText,
  MODEL_ERROR_ACTION_LABEL,
  modelErrorCard,
  modelErrorMark,
} from '../src/core/friendly-error.js';
import { compactarRetryTarget } from '../src/retry-turn.js';

describe('tarjeta de error en Telegram (Hermes: bloqueante o pasajero + una acción)', () => {
  it('clasifica el fallo y elige la acción que lo arregla', () => {
    expect(modelErrorCard('prompt is too long: 250000 tokens > 200000 maximum')).toEqual({
      kind: 'bloqueante',
      action: 'compactar',
    });
    expect(modelErrorCard('401 Unauthorized: invalid api key')).toEqual({
      kind: 'bloqueante',
      action: 'estado',
    });
    expect(modelErrorCard('402 insufficient funds')).toEqual({
      kind: 'bloqueante',
      action: 'estado',
    });
    expect(modelErrorCard('fetch failed')).toEqual({ kind: 'pasajero', action: 'reintentar' });
    expect(modelErrorCard('429 rate limit')).toEqual({ kind: 'pasajero', action: 'reintentar' });
    expect(modelErrorCard('TypeError: x is undefined')).toEqual({
      kind: 'pasajero',
      action: 'reintentar',
    });
    // El guardia y lo que paró el dueño no son fallos que arreglar.
    expect(modelErrorCard('Te detuve porque ibas a borrar algo')).toBeNull();
    expect(modelErrorCard('Request was aborted')).toBeNull();
    expect(modelErrorCard('')).toBeNull();
  });

  it('el texto lleva la marca: ⛔ si bloquea, ⚠️ si es pasajero; sin fallo, nada', () => {
    const largo = { text: '', error: 'maximum context length exceeded' };
    expect(modelErrorMark(largo)).toBe('⛔ ');
    expect(modelErrorMark(largo) + chatReplyText(largo)).toContain('⛔ La conversación');
    expect(modelErrorMark({ text: '', error: 'invalid api key' })).toBe('⛔ ');
    expect(modelErrorMark({ text: '', error: 'ECONNRESET' })).toBe('⚠️ ');
    expect(modelErrorMark({ text: 'hola', error: 'fetch failed' })).toBe('');
    expect(modelErrorMark({ text: '', error: null })).toBe('');
    expect(modelErrorMark({ text: '', error: 'Te detuve porque X' })).toBe('');
  });

  it('cli: la marca va delante del texto y el botón sale de la tarjeta', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain(
      'modelErrorMark(result) + chatReplyText(result) + modelErrorAsk(inbound, result, !out)',
    );
    expect(cli).toContain(
      "commandButton(MODEL_ERROR_ACTION_LABEL.compactar, 'compactar', id, 'reintentar')",
    );
    expect(cli).toContain('if (retryId && compacted) await cmdReintentar(');
  });

  it('los botones caben en los 64 bytes y vuelven a ser la orden que arregla', () => {
    const id = '1234567890123';
    const resumir = commandButton(
      MODEL_ERROR_ACTION_LABEL.compactar,
      'compactar',
      id,
      'reintentar',
    );
    expect(resumir?.label).toBe('🗜️ Resumir y reintentar');
    expect(commandFromCallback(resumir?.action ?? '')).toBe(`/compactar reintentar ${id}`);
    expect(compactarRetryTarget(`reintentar ${id}`)).toBe(id);
    expect(compactarRetryTarget('')).toBeUndefined();
    const estado = commandButton(MODEL_ERROR_ACTION_LABEL.estado, 'estado', 'ver');
    expect(commandFromCallback(estado?.action ?? '')).toBe('/estado ver');
    // Nada que no esté en la lista: un «/compactar borrar» falso no pasa.
    expect(commandFromCallback('cmd:compactar borrar 1')).toBeUndefined();
  });
});

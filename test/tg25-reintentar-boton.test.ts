import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «🔄 Reintentar» bajo una respuesta que falló (tiempo agotado, error del modelo, fallo
 * interno): un toque repite ESE mensaje, como /reintentar. Antes había que escribir
 * /reintentar (que nadie recuerda) o copiar el mensaje otra vez. Un botón viejo, con
 * otro mensaje del dueño después, no repite uno distinto.
 */
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import {
  LastTurns,
  RETRY_BUTTON_LABEL,
  RETRY_STALE_TEXT,
  retryMatches,
  retryTarget,
} from '../src/retry-turn.js';

describe('el botón «🔄 Reintentar»', () => {
  it('equivale a escribir «/reintentar <id del mensaje>»', () => {
    const button = commandButton(RETRY_BUTTON_LABEL, 'reintentar', '4821');
    expect(button?.label).toBe('🔄 Reintentar');
    expect(Buffer.byteLength(button?.action ?? '')).toBeLessThanOrEqual(64);
    expect(commandFromCallback(button?.action ?? '')).toBe('/reintentar 4821');
    // Lista cerrada: subórdenes inventadas no valen.
    expect(commandButton('x', 'reintentar', '1', 'borra')).toBeUndefined();
  });

  it('lee el id del botón; /reintentar a mano repite el último como siempre', () => {
    expect(retryTarget('/reintentar 4821')).toBe('4821');
    expect(retryTarget('/reintentar@asistenta_bot 77')).toBe('77');
    expect(retryTarget('/reintentar')).toBeUndefined();
    expect(retryTarget('/reintentar ahora mismo')).toBeUndefined();
  });

  it('un botón viejo no repite otro mensaje', () => {
    const turns = new LastTurns<string>();
    turns.remember('t', {
      text: 'busca vuelos',
      agent: 'a',
      mark: 0,
      compactions: 0,
      messageId: '10',
    });
    expect(retryMatches(turns.get('t'), '10')).toBe(true);
    expect(retryMatches(turns.get('t'), undefined)).toBe(true);
    turns.remember('t', {
      text: 'otra cosa',
      agent: 'a',
      mark: 2,
      compactions: 0,
      messageId: '12',
    });
    expect(retryMatches(turns.get('t'), '10')).toBe(false);
    expect(RETRY_STALE_TEXT).toMatch(/mándamelo otra vez/);
  });
});

describe('dónde sale', () => {
  const cli = readFileSync('src/cli.ts', 'utf8');

  it('el turno apunta el id del mensaje del dueño para el botón', () => {
    expect(cli).toMatch(
      /text: turnInbound\.text,\s+images: turnInbound\.images,\s+messageId: turnInbound\.messageId,/,
    );
  });

  it('una respuesta con error que no se reintenta sola lo lleva', () => {
    expect(cli).toMatch(
      /if \(!out && result\.error !== null && !autoRetryLater && !opts\.external\)\s+retryOffered\.add\(inbound\.messageId\);/,
    );
    expect(cli).toContain(
      'const retry = retryOffered.delete(inbound.messageId) ? retryButtons(thread) : undefined;',
    );
    expect(cli).toContain('autoRetryLater = delay !== null;');
    expect(cli).toContain(': (retry ?? quickReplyButtons(short.text));');
  });

  it('un turno que revienta también', () => {
    expect(cli).toMatch(
      /friendlyError\(err, 'Algo falló: '\), \{\s+quote: true,\s+buttons: opts\.external \? undefined : retryButtons\(thread\),/,
    );
  });

  it('/reintentar desde un botón viejo avisa y no repite', () => {
    expect(cli).toMatch(/!retryMatches\(last, retryTarget\(inbound\.text\)\)/);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  chatReplyText,
  friendlyModelError,
  MODEL_ERROR_QUESTION,
  modelErrorFollowUp,
} from '../src/core/friendly-error.js';
import { PreguntasPendientes, SI_RESPUESTA } from '../src/daemon/pregunta-pendiente.js';

// Nico (1 nov): que hable como un amigo, sin mandarle a comandos.
const LARGO = 'prompt is too long: 300000 tokens';
const INTERNO = "TypeError: Cannot read properties of undefined (reading 'x')";

describe('fallos del modelo sin mandar a /compactar ni /reintentar', () => {
  it('los textos de fallo no nombran comandos', () => {
    for (const raw of [LARGO, INTERNO, 'fetch failed', '429 Too Many Requests']) {
      expect(friendlyModelError(raw), raw).not.toMatch(/\/\w/);
      expect(chatReplyText({ text: '', error: raw }), raw).not.toMatch(/\/\w/);
    }
    expect(friendlyModelError(LARGO)).toBe(
      'La conversación se ha hecho demasiado larga para el modelo.',
    );
    expect(friendlyModelError(INTERNO)).toBe(
      'No he podido terminar la respuesta por un fallo interno.',
    );
  });

  it('un «sí» después del fallo resume o repite, según el caso', () => {
    expect(modelErrorFollowUp(LARGO)).toBe('compactar');
    expect(modelErrorFollowUp(INTERNO)).toBe('reintentar');
    expect(modelErrorFollowUp('fetch failed')).toBeNull();
    expect(modelErrorFollowUp('401 Unauthorized')).toBeNull();
    expect(MODEL_ERROR_QUESTION.compactar).toBe(
      '¿La resumo para poder seguir? Dime «sí» y luego vuelve a pedírmelo.',
    );
    expect(MODEL_ERROR_QUESTION.reintentar).toBe('¿Lo intento otra vez? Dime «sí».');
    const p = new PreguntasPendientes();
    p.ask('c', 'reintentar', { answer: (t) => (SI_RESPUESTA.test(t) ? '' : null) });
    expect(p.consume('c', 'sí')).toEqual({ name: 'reintentar', args: '' });
    p.ask('c', 'compactar', { answer: (t) => (SI_RESPUESTA.test(t) ? '' : null) });
    expect(p.consume('c', 'qué tal el tiempo')).toBeNull();
  });

  it('el chat de Telegram hace la pregunta y apunta la respuesta; el panel no', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('chatReplyText(result) + modelErrorAsk(inbound, result, !out)');
    expect(cli).toMatch(
      /preguntas\.ask\(chatKey\(inbound\), cmd, \{ answer: \(t\) => \(SI_RESPUESTA\.test\(t\) \? '' : null\) \}\)/,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { tvButtonAction } from '../src/cli.js';

describe('tvButtonAction', () => {
  it('abre sesión con micro aunque la conversación esté apagada (el modo no es entrada: auditoría, botón TV)', () => {
    // /conversacion vuelve a off en cada reinicio: si el modo mandara, el
    // botón sería un no-op silencioso hasta /conversacion on. No lo es.
    expect(tvButtonAction({ hasChat: true, hasListener: true, sessionOpen: false })).toBe(
      'open-session',
    );
  });

  it('sin chat (nadie ha hablado aún) no hay dónde abrir la sesión', () => {
    expect(tvButtonAction({ hasChat: false, hasListener: true, sessionOpen: false })).toBe(
      'no-chat',
    );
  });

  it('sin listener no hay audio para la sesión: se pide encender el micro en vez de callar', () => {
    expect(tvButtonAction({ hasChat: true, hasListener: false, sessionOpen: false })).toBe(
      'need-mic',
    );
  });

  it('con una sesión ya abierta el botón no abre otra', () => {
    expect(tvButtonAction({ hasChat: true, hasListener: true, sessionOpen: true })).toBe(
      'already-open',
    );
  });
});

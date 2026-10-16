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

// --- Canary de ejecución (auditor #154 ronda 1): la promesa "dice Dime." ---
// speakAloud (cli.ts) ya llama owner.speak() por dentro. Envolverlo en otro
// opened.speak() pone estado='hablando' y el interior devuelve 'fin' SIN
// sintetizar ni reproducir (conversation.ts: guarda de estado). Este canario
// ejecuta ambos patrones contra una ConversationSession real con synth/play
// espiados: el anidado suena cero veces; el directo, exactamente una.
import { ConversationSession } from '../src/voice/conversation.js';

describe('saludo hablado de la sesión (ejecución real)', () => {
  it('speak anidado = silencio; speakAloud directo = audio UNA vez', async () => {
    const synthCalls: string[] = [];
    const playCalls: string[] = [];
    const session = new ConversationSession({
      transcriber: async () => 'nada',
      onUtterance: async () => {},
      onClose: () => {},
    });
    // Réplica 1:1 de la estructura de speakAloud con synth/play espiados.
    const speakOnce = async (text: string, owner: ConversationSession): Promise<void> => {
      await owner.speak(async () => {
        const file = await (async (t: string) => {
          synthCalls.push(t);
          return '/tmp/fake.mp3';
        })(text);
        await (async (f: string) => {
          playCalls.push(f);
        })(file);
      });
    };

    // Patrón que había en handleWake y handleButton: speak(speakAloud) anidado.
    await session.speak(() => speakOnce('Dime.', session));
    expect(synthCalls).toHaveLength(0);
    expect(playCalls).toHaveLength(0);

    // Patrón corregido: speakAloud directo sobre la sesión abierta.
    await speakOnce('Dime.', session);
    expect(synthCalls).toEqual(['Dime.']);
    expect(playCalls).toEqual(['/tmp/fake.mp3']);

    session.close('apagado');
  });

  it('la sesión que abre el botón (sin /conversacion on) es una sesión normal que habla', async () => {
    // El botón abre con openSession(force): conversationOn no interviene. La
    // sesión resultante es una ConversationSession estándar: escucha y habla.
    const synthCalls: string[] = [];
    const session = new ConversationSession({
      transcriber: async () => 'nada',
      onUtterance: async () => {},
      onClose: () => {},
    });
    await session.speak(async () => {
      synthCalls.push('Dime.');
    });
    expect(synthCalls).toEqual(['Dime.']);
    session.close('apagado');
  });
});

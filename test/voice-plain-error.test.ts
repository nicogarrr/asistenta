import { describe, expect, it } from 'vitest';
import { type CloseReason, ConversationSession, SAMPLE_RATE } from '../src/voice/conversation.js';

const CHUNK = SAMPLE_RATE / 10;
const voice = (): Float32Array => {
  const out = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / SAMPLE_RATE) * 0.2;
  return out;
};
const quiet = (): Float32Array => new Float32Array(CHUNK);
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function session(fail: { transcribe?: Error; turn?: Error }) {
  const closed: Array<{ reason: CloseReason; detail?: string }> = [];
  const s = new ConversationSession({
    tailMs: 0,
    transcriber: async () => {
      if (fail.transcribe) throw fail.transcribe;
      return 'qué hora es';
    },
    onUtterance: async () => {
      if (fail.turn) throw fail.turn;
    },
    onClose: (reason, detail) => closed.push({ reason, detail }),
  });
  const speak = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) s.feed(voice());
    for (let i = 0; i < 10; i++) s.feed(quiet());
    await settle();
  };
  return { s, closed, speak };
}

const RAW = /fetch|ENOENT|ECONN|spawn|whisper|\/usr\/|https?:/;

describe('voz: el último fallo se dice en castellano, sin el error crudo', () => {
  it('sin red al transcribir: frase clara en el estado', async () => {
    const { s, speak } = session({ transcribe: new TypeError('fetch failed') });
    await speak();
    expect(s.stats().lastError).toBe('no hay conexión con el servicio de voz');
  });

  it('falta el programa de voz: ni ruta ni código en el aviso de cierre', async () => {
    const { closed, speak } = session({
      transcribe: new Error('spawn /usr/local/bin/whisper ENOENT'),
    });
    for (let i = 0; i < 3; i++) await speak();
    expect(closed).toEqual([
      { reason: 'fallo', detail: 'no consigo transcribir: falta un programa o archivo de voz' },
    ]);
    expect(closed[0]?.detail).not.toMatch(RAW);
  });

  it('un turno que falla con texto técnico en inglés no lo enseña', async () => {
    const { s, speak } = session({ turn: new Error('Request failed with status code 503') });
    await speak();
    expect(s.stats().lastError).toBe('el servicio de voz no responde bien');
  });

  it('un fallo ya escrito en castellano pasa tal cual', async () => {
    const { s, speak } = session({ turn: new Error('el modelo no respondió') });
    await speak();
    expect(s.stats().lastError).toBe('el modelo no respondió');
  });
});

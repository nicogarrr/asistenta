import { describe, expect, it } from 'vitest';
import { LiveNote } from '../src/channels/telegram-receipts.js';

/**
 * La nota de progreso de un turno largo: antes salía un mensaje NUEVO cada 45 s
 * (una notificación por mensaje en el móvil); ahora es una sola que se edita.
 */
function chat(sendDelayMs = 0) {
  const log: string[] = [];
  let n = 100;
  return {
    log,
    deps: {
      send: async (text: string) => {
        if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
        log.push(`send:${text}`);
        return String(n++);
      },
      edit: async (id: string, text: string) => {
        log.push(`edit:${id}:${text}`);
      },
    },
  };
}

describe('LiveNote: una sola nota de progreso por turno', () => {
  it('la primera vez publica; las siguientes editan el mismo mensaje', async () => {
    const c = chat();
    const note = new LiveNote(c.deps);
    await note.show('Sigo con ello (1 min)');
    await note.show('Sigo con ello (2 min)');
    await note.show('Sigo con ello (3 min)');
    expect(c.log).toEqual([
      'send:Sigo con ello (1 min)',
      'edit:100:Sigo con ello (2 min)',
      'edit:100:Sigo con ello (3 min)',
    ]);
    expect(note.id).toBe('100');
  });

  it('un segundo aviso mientras el primero sigue enviándose no publica otro mensaje', async () => {
    const c = chat(20);
    const note = new LiveNote(c.deps);
    const a = note.show('uno');
    const b = note.show('dos');
    await Promise.all([a, b]);
    expect(c.log).toEqual(['send:uno', 'edit:100:dos']);
  });

  it('no reescribe el mismo texto', async () => {
    const c = chat();
    const note = new LiveNote(c.deps);
    await note.show('igual');
    await note.show('igual');
    expect(c.log).toEqual(['send:igual']);
  });

  it('si Telegram falla al publicar, el siguiente aviso lo vuelve a intentar', async () => {
    let fail = true;
    const log: string[] = [];
    const note = new LiveNote({
      send: async (text) => {
        if (fail) {
          fail = false;
          throw new Error('429');
        }
        log.push(`send:${text}`);
        return '7';
      },
      edit: async () => {},
    });
    await expect(note.show('a')).resolves.toBeUndefined();
    await note.show('b');
    expect(log).toEqual(['send:b']);
  });
});

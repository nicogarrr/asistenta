import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectionThreadKey, runMemoryCommand } from '../src/cli.js';
import { MemoryStore } from '../src/memory.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-memory-cmd-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('runMemoryCommand', () => {
  it('lee el scope thread.key, no el chatKey pelado (auditoría: /memory casi siempre decía que no recordaba nada)', () => {
    const store = new MemoryStore(dir);
    // Así guarda todo lo demás (contexto del turno, tool memory): chatKey#thread.
    store.remember('telegram:123#main', 'prefiere respuestas cortas');
    const reply = runMemoryCommand(store, 'telegram:123#main');
    expect(reply).toContain('Recuerdo 1 cosas:');
    expect(reply).toContain('prefiere respuestas cortas');
    // El scope viejo del comando: con la memoria llena decía no recordar nada.
    expect(runMemoryCommand(store, 'telegram:123')).toContain('No recuerdo nada');
  });

  it('sin memoria lo dice y cuenta las conversaciones con memoria', () => {
    const store = new MemoryStore(dir);
    expect(runMemoryCommand(store, 'telegram:123#main')).toContain(
      '(0 conversaciones con memoria)',
    );
    store.remember('telegram:999#main', 'un dato de otro chat');
    expect(runMemoryCommand(store, 'telegram:123#main')).toContain(
      '(1 conversaciones con memoria)',
    );
  });
});

describe('inspectionThreadKey', () => {
  it('sin intención explícita lee main aunque esté ocupado, sin crear hilo (auditor #152 ronda 1)', () => {
    // main.active=true no es una entrada de esta función: la inspección no
    // mira ocupación ni crea nada. El bug era la heurística de peticiones
    // nuevas creando #m<messageId> y contestando desde su memoria vacía.
    const store = new MemoryStore(dir);
    store.remember('telegram:main:42#main', 'prefiere respuestas cortas');
    const key = inspectionThreadKey({ chatKey: 'telegram:main:42' });
    expect(key).toBe('telegram:main:42#main');
    expect(runMemoryCommand(store, key)).toContain('prefiere respuestas cortas');
  });

  it('recupera el hilo de una notificación persistida de objetivo y rechaza un chat ajeno (auditor #152 ronda 2)', () => {
    // Mapa volátil vacío (reinicio del daemon): la ruta durable llega por
    // replyGoalScope y apunta al hilo del objetivo, no a main.
    const store = new MemoryStore(dir);
    store.remember('k#m7', 'el objetivo pidió un presupuesto');
    expect(inspectionThreadKey({ chatKey: 'k', replyGoalScope: 'k#m7' })).toBe('k#m7');
    expect(
      runMemoryCommand(store, inspectionThreadKey({ chatKey: 'k', replyGoalScope: 'k#m7' })),
    ).toContain('el objetivo pidió un presupuesto');
    // Un scope de OTRO chat jamás se sigue: cae a main de este chat.
    expect(inspectionThreadKey({ chatKey: 'k', replyGoalScope: 'otro:chat#m7' })).toBe('k#main');
    // La respuesta volátil manda sobre la durable, como en resolveThread.
    expect(
      inspectionThreadKey({ chatKey: 'k', replyThreadKey: 'k#m99', replyGoalScope: 'k#m7' }),
    ).toBe('k#m99');
  });

  it('respeta /topic explícito, respuesta a un mensaje e hilo de Telegram, en ese orden', () => {
    expect(inspectionThreadKey({ chatKey: 'k', activeTopic: 'renfe' })).toBe('k#renfe');
    expect(inspectionThreadKey({ chatKey: 'k', replyThreadKey: 'k#m99' })).toBe('k#m99');
    expect(inspectionThreadKey({ chatKey: 'k', threadId: '7' })).toBe('k#t7');
    expect(
      inspectionThreadKey({
        chatKey: 'k',
        activeTopic: 'renfe',
        replyThreadKey: 'k#m99',
        threadId: '7',
      }),
    ).toBe('k#renfe');
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PanelChatThread, runPanelChat } from '../src/daemon/panel-chat.js';
import { learnedRulesCommand, saveLearnedRule } from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-panel-cmd-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function thread(): PanelChatThread {
  return { key: SCOPE, generation: 0, tail: Promise.resolve(), active: false } as PanelChatThread;
}

describe('/aprendido y /olvida en el chat del panel', () => {
  it('lista y borra igual que en Telegram, sin pasar por el modelo', async () => {
    saveLearnedRule(memory, SCOPE, 'Respuestas cortas', 'formato');
    saveLearnedRule(memory, SCOPE, 'Sin emojis', 'emojis');
    const runTurn = vi.fn(async () => {});
    const remember = vi.fn();
    const deps = {
      remember,
      runTurn,
      command: (t: PanelChatThread, said: string) => learnedRulesCommand(memory, [t.key], said),
    };
    const list = await runPanelChat(thread(), '/aprendido', deps);
    expect(list.text).toContain('1. Sin emojis');
    expect(list.text).toContain('2. Respuestas cortas');
    const del = await runPanelChat(thread(), ' /olvida 1 ', deps);
    expect(del.text).toBe('🗑️ Olvidada: Sin emojis');
    expect(runTurn).not.toHaveBeenCalled();
    // Un comando no se apunta para «Reintentar».
    expect(remember).not.toHaveBeenCalled();
    expect((await runPanelChat(thread(), '/aprendido', deps)).text).not.toContain('Sin emojis');
  });

  it('el resto del texto va al modelo como siempre', async () => {
    saveLearnedRule(memory, SCOPE, 'Respuestas cortas');
    for (const said of ['olvida lo de ayer', '/olvidame', 'qué has aprendido?', '/aprendidoX']) {
      expect(learnedRulesCommand(memory, [SCOPE], said)).toBeNull();
    }
    const runTurn = vi.fn(
      async (_t: PanelChatThread, _s: string, out: { answer(t: string): void }) =>
        out.answer('hola'),
    );
    const reply = await runPanelChat(thread(), 'hola', {
      remember: () => {},
      runTurn,
      command: (t, said) => learnedRulesCommand(memory, [t.key], said),
    });
    expect(reply.text).toBe('hola');
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('/olvida sin número no borra nada', () => {
    saveLearnedRule(memory, SCOPE, 'Respuestas cortas');
    expect(learnedRulesCommand(memory, [SCOPE], '/olvida')).toMatch(/^¿Cuál borro\?/);
    expect(learnedRulesCommand(memory, [SCOPE], '/olvida todo')).toMatch(/^¿Cuál borro\?/);
    expect(learnedRulesCommand(memory, [SCOPE], '/aprendido')).toContain('Respuestas cortas');
  });

  it('cableado: el chat del panel (hilo principal del dueño) usa los ámbitos de /aprendido', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const calls =
      cli.match(
        /command: \(t, said\) => learnedRulesCommand\(memory, memoryScopesFor\(t\.key\)\.read, said\)/g,
      ) ?? [];
    expect(calls).toHaveLength(1);
  });
});

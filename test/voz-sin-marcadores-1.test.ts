import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Routine } from '../src/db.js';
import {
  forgetLearnedRule,
  formatLearnedRules,
  learnedRules,
  saveLearnedRule,
} from '../src/memory/learned-rules.js';
import { contradictionsReply } from '../src/memory/review.js';
import { MemoryStore } from '../src/memory.js';
import { formatReminderRows, pickReminder } from '../src/tools/reminder.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

// Nico (1 nov): «quiero que nuestro agente sea natural, conversaciones naturales,
// no usar cosas como <número o palabra>». Las respuestas de recordatorios, reglas
// aprendidas, memoria y perfil enseñaban la sintaxis como un manual de terminal
// («Uso: /olvida <número>»). Ahora: una pregunta normal y un ejemplo real.
const MARCADOR = /<[^<>\n]{1,40}>|\bUso:|\[[a-z|]+ ?\|/i;
const cli = readFileSync('src/cli.ts', 'utf8');

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-voz-sin-marcadores-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('respuestas naturales, sin <marcadores> (1): recordatorios, aprendido, memoria y perfil', () => {
  it('/recordatorios: el pie da un ejemplo de verdad', () => {
    const taller = {
      id: 'recordatorio-1:taller',
      scope: 'chat',
      name: 'recordatorio-1:taller',
      kind: 'schedule',
      params: null,
      steps: null,
      prompt: 'Llamar al taller',
      schedule: '0 9 2 11 *',
      enabled: true,
      createdAt: '',
      updatedAt: '',
    } as Routine;
    const text = formatReminderRows([{ routine: taller, next: null }], new Date(2026, 10, 1, 9, 0));
    expect(text).not.toMatch(MARCADOR);
    expect(text).toContain('/recordatorios borrar 2');
  });

  it('/recordatorios borrar sin decir cuál: pregunta cuál, con ejemplo', () => {
    const r = pickReminder([], '  ');
    expect(r.ok).toBe(false);
    const error = r.ok ? '' : r.error;
    expect(error).toMatch(/^¿Cuál quito\?/);
    expect(error).not.toMatch(MARCADOR);
  });

  it('/aprendido y /olvida: sin <número> ni «Uso:»', () => {
    saveLearnedRule(memory, SCOPE, 'Responder corto', 'longitud');
    saveLearnedRule(memory, SCOPE, 'No usar emojis', 'emojis');
    saveLearnedRule(memory, SCOPE, 'Emojis solo en el correo', 'correo');
    const list = formatLearnedRules(learnedRules(memory, [SCOPE]));
    expect(list).not.toMatch(MARCADOR);
    expect(list).toContain('/olvida 2');
    const mal = forgetLearnedRule(memory, [SCOPE], 'todo');
    expect(mal).toMatch(/^¿Cuál borro\?/);
    expect(mal).not.toMatch(MARCADOR);
    const varias = forgetLearnedRule(memory, [SCOPE], 'emojis');
    expect(varias).toContain('¿Cuál de ellas?');
    expect(learnedRules(memory, [SCOPE])).toHaveLength(3);
    expect(varias).not.toMatch(MARCADOR);
  });

  it('/memoria revisar: ejemplo con un código, no <id>', () => {
    const r = contradictionsReply([
      { id: 'm1', text: 'Vive en Madrid' },
      { id: 'm3', text: 'No vive en Madrid' },
    ]);
    expect(r).not.toMatch(/<id>/);
    expect(r).toContain('/memoria olvidar a1b2c3');
  });

  it('/buscar, /memoria y /perfil en Telegram: preguntas normales con ejemplo', () => {
    for (const viejo of [
      'Uso: /buscar <texto>',
      'Uso: /memoria buscar <texto>',
      'Uso: /memoria olvidar <id>',
      'Uso: /memoria [listar',
      'Uso: /perfil guardar <texto>',
      'Uso: /perfil olvidar <id|texto>',
      'Uso: /perfil [listar',
      'con /perfil guardar <texto>',
      'Uso: /recordatorios ⬦',
    ]) {
      expect(cli).not.toContain(viejo);
    }
    expect(cli).toContain("'¿Qué busco? Por ejemplo: /buscar presupuesto del taller.'");
    expect(cli).toContain(
      '¿Qué guardo? Por ejemplo: /perfil guardar soy alérgico a los frutos secos.',
    );
    expect(cli).toContain('«recuérdame mañana a las 9 llamar al taller»');
  });
});

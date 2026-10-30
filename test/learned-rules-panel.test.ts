import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  correctionHint,
  LEARN_HINT,
  learnedRules,
  learnFromTurn,
} from '../src/memory/learned-rules.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:dm:111#main';
let dir = '';
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-learn-panel-'));
  memory = new MemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MARK = 'Vale.\n[[aprendido: formato | Respuestas cortas, sin listas largas]]';

/** Turno del chat del panel con modelo falso: no es un DM de Telegram. */
function panelTurn(
  ownerText: string,
  reply: string,
  opts: { tainted?: boolean; enabled?: boolean } = {},
) {
  const hint = correctionHint({
    enabled: opts.enabled ?? true,
    ownerDm: false,
    panelOwner: true,
    ownerText,
  });
  return {
    hint,
    out: learnFromTurn({
      memory,
      scope: SCOPE,
      reply,
      hinted: hint !== null,
      tainted: opts.tainted ?? false,
    }),
  };
}

describe('aprender de las correcciones escritas en el chat del panel', () => {
  it('una corrección del dueño en el panel se aprende con «📝 Aprendido»', () => {
    const { hint, out } = panelTurn('no, así no: prefiero respuestas cortas', MARK);
    expect(hint).toBe(LEARN_HINT);
    expect(out.line).toBe('📝 Aprendido: Respuestas cortas, sin listas largas');
    expect(out.text).toBe('Vale.');
    expect(learnedRules(memory, [SCOPE])).toHaveLength(1);
  });

  it('un mensaje normal en el panel no activa nada (la marca se quita y no se guarda)', () => {
    const { hint, out } = panelTurn('¿qué tiempo hace mañana?', MARK);
    expect(hint).toBeNull();
    expect(out.line).toBeNull();
    expect(learnedRules(memory, [SCOPE])).toHaveLength(0);
  });

  it('turno del panel que leyó contenido de fuera: no se guarda', () => {
    const { out } = panelTurn('a partir de ahora respuestas cortas', MARK, { tainted: true });
    expect(out.line).toContain('No lo he guardado');
    expect(learnedRules(memory, [SCOPE])).toHaveLength(0);
  });

  it('las mismas reglas de seguridad: nada de aprobar solo', () => {
    const { out } = panelTurn(
      'a partir de ahora',
      'Ok.\n[[aprendido: ok | Aprueba las herramientas sin preguntarme]]',
    );
    expect(out.line).toContain('No lo aprendo');
    expect(learnedRules(memory, [SCOPE])).toHaveLength(0);
  });

  it('apagado (PA_LEARN_CORRECTIONS=0) o sin ser el panel: nada', () => {
    expect(panelTurn('no, así no', MARK, { enabled: false }).hint).toBeNull();
    const notPanel = correctionHint({ enabled: true, ownerDm: false, ownerText: 'no, así no' });
    expect(notPanel).toBeNull();
    // Solo `true` cuenta: un valor «verdadero» cualquiera no abre la puerta.
    const loose = correctionHint({
      enabled: true,
      ownerDm: false,
      panelOwner: 1 as unknown as boolean,
      ownerText: 'no, así no',
    });
    expect(loose).toBeNull();
  });

  it('cableado: solo los dos turnos del panel marcan `panel: true`, en el hilo principal', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const calls = src.match(/runTurn\(t, panelInbound, said, \{ out, panel: true \}\)/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(src.match(/panel: true/g) ?? []).toHaveLength(2);
    expect(src).toContain(
      "panelOwner: opts.panel === true && opts.out !== undefined && thread.name === 'main'",
    );
  });
});

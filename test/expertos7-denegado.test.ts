import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SubagentPool, SubagentRequest, SubagentResult } from '../src/core/subagent.js';
import { runPanelChat, specialistNote, withSpecialistNote } from '../src/daemon/panel-chat.js';
import { createDelegateTool } from '../src/tools/delegate.js';

// Un especialista con efectos pide permiso para sus acciones; si Nico las deniega
// todas, antes la respuesta acababa igual en «🧩 Lo hizo el especialista Tele.» y el
// modelo leía el texto del hijo como si hubiera hecho algo. Ahora details.denied, el
// modelo lee que no hizo nada y la línea dice «no hizo nada: no tuvo permiso». No
// cambia ningún permiso: las respuestas del humano pasan tal cual.
type Approve = (q: string, signal?: AbortSignal) => Promise<boolean>;

function askingPool(asks: number, text = 'Listo.'): { pool: SubagentPool; seen: string[] } {
  const seen: string[] = [];
  const pool = {
    run: async (req: SubagentRequest): Promise<SubagentResult> => {
      const approve = (req.context as { approve?: Approve } | undefined)?.approve;
      for (let i = 0; i < asks; i++) {
        const ok = await approve?.(`acción ${i}`);
        seen.push(`acción ${i}: ${ok}`);
      }
      return { text, depth: 1 };
    },
  } as unknown as SubagentPool;
  return { pool, seen };
}

async function delegate(pool: SubagentPool, answers: boolean[], specialist = 'tele') {
  let n = 0;
  const asked: string[] = [];
  const tool = createDelegateTool(pool, () => 0, {
    parentTools: () => [],
    approve: async (q) => {
      asked.push(q);
      return answers[n++] ?? false;
    },
  });
  const out = (await (tool.execute as (...a: unknown[]) => Promise<unknown>)(
    'id',
    { task: 'apaga la tele', specialist },
    undefined,
  )) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  return { text: out.content[0]?.text ?? '', details: out.details, asked };
}

describe('delegate: todo lo que pidió el especialista se denegó', () => {
  it('una sola acción denegada: details.denied y el modelo lo lee', async () => {
    const { pool, seen } = askingPool(1, 'No pude apagarla.');
    const r = await delegate(pool, [false]);
    expect(seen).toEqual(['acción 0: false']);
    expect(r.details).toEqual({ depth: 1, specialist: 'tv', denied: true });
    expect(r.text).toContain('No pude apagarla.');
    expect(r.text).toContain('no tuvo permiso para ninguna de las acciones');
    expect(r.text).toMatch(/no lo des por hecho/i);
  });

  it('dos denegadas: también', async () => {
    const r = await delegate(askingPool(2).pool, [false, false]);
    expect(r.details.denied).toBe(true);
    expect(r.asked).toHaveLength(2);
  });

  it('una sí y otra no: lo hizo (sin denied, texto igual)', async () => {
    const r = await delegate(askingPool(2).pool, [true, false]);
    expect(r.details).toEqual({ depth: 1, specialist: 'tv' });
    expect(r.text).toBe('Listo.');
  });

  it('sin preguntar nada: igual que antes', async () => {
    const r = await delegate(askingPool(0).pool, []);
    expect(r.details).toEqual({ depth: 1, specialist: 'tv' });
    expect(r.text).toBe('Listo.');
  });

  it('la respuesta del humano pasa tal cual (no se aprueba nada de más)', async () => {
    const { pool, seen } = askingPool(3);
    await delegate(pool, [false, true, false]);
    expect(seen).toEqual(['acción 0: false', 'acción 1: true', 'acción 2: false']);
  });

  it('si además volvió vacío, manda el aviso de vacío (error) y no denied', async () => {
    const r = await delegate(askingPool(1, '').pool, [false]);
    expect(typeof r.details.error).toBe('string');
    expect(r.details.denied).toBeUndefined();
  });
});

describe('la línea 🧩 cuando no tuvo permiso', () => {
  it('uno y varios', () => {
    expect(specialistNote([], ['tv'])).toBe(
      '🧩 El especialista Tele no hizo nada: no tuvo permiso.',
    );
    expect(specialistNote([], ['tv', 'hogar', 'tv'])).toBe(
      '🧩 Los especialistas Tele y Casa no hicieron nada: no tuvieron permiso.',
    );
  });

  it('si otra delegación suya sí hizo algo, solo «Lo hizo»', () => {
    expect(specialistNote(['tv'], ['tv'])).toBe('🧩 Lo hizo el especialista Tele.');
    expect(specialistNote(['correo'], ['tv'])).toBe(
      '🧩 Lo hizo el especialista Correo.\n🧩 El especialista Tele no hizo nada: no tuvo permiso.',
    );
  });

  it('Telegram: la línea honesta al final; sin nada, igual', () => {
    expect(withSpecialistNote('Vale, no la apago.', [], ['tv'])).toBe(
      'Vale, no la apago.\n\n🧩 El especialista Tele no hizo nada: no tuvo permiso.',
    );
    expect(withSpecialistNote('hola', [])).toBe('hola');
  });

  it('panel: la línea honesta en vez de «Lo hizo»', async () => {
    const r = await runPanelChat(
      { key: 'telegram:dm:1:main', generation: 0, tail: Promise.resolve(), active: false },
      'apaga la tele',
      {
        remember: () => {},
        runTurn: async (_t, _text, out) => {
          out.specialistDenied?.('tv');
          out.answer('No la he apagado.');
        },
      },
    );
    expect(r.text).toBe(
      'No la he apagado.\n\n🧩 El especialista Tele no hizo nada: no tuvo permiso.',
    );
  });

  it('cli.ts pasa specialistDenied al panel y a Telegram', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/if \(out\) out\.specialistDenied\?\.\(info\.specialistDenied\);/);
    expect(source).toMatch(
      /withSpecialistNote\(result\.text, specialistsUsed, specialistsDenied\)/,
    );
  });
});

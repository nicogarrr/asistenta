import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const type = (text: string): ToolCall => ({
  tool: 'computer',
  args: { action: 'type', text },
  actor: 'asistenta',
});
const key = (k: string): ToolCall => ({
  tool: 'computer',
  args: { action: 'key', key: k },
  actor: 'asistenta',
});
// Control total: todo sin preguntar salvo dinero y credenciales.
const gate = () => new Gate({ fullControl: true, approver: async () => true });

async function run(g: Gate, calls: ToolCall[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of calls) out.push((await g.check(S, c)).verdict);
  return out;
}

describe('una orden tecleada a trozos en una terminal del escritorio se lee entera', () => {
  it('«pa vault g» y luego «et x» se deniega', async () => {
    expect(await run(gate(), [type('pa vault g'), type('et telegram:botToken')])).toEqual([
      'allow',
      'deny',
    ]);
  });

  it('tecla a tecla también', async () => {
    const calls = [type('pa vault ge'), key('t'), key('space'), type('x')];
    expect((await run(gate(), calls)).includes('deny')).toBe(true);
  });

  it('borrar con retroceso no la esconde', async () => {
    expect(await run(gate(), [type('pa vault gex'), key('backspace'), type('t x')])).toEqual([
      'allow',
      'allow',
      'deny',
    ]);
  });

  it('pa con la orden en una variable, tecleado', async () => {
    expect(await run(gate(), [type('$v="vault"; pa $v get x')])).toEqual(['deny']);
    expect(await run(gate(), [type('$v="vault"'), key('enter'), type('pa $v get x')])).toEqual([
      'allow',
      'allow',
      'deny',
    ]);
  });

  it('Enter empieza una línea nueva: lo de antes no se suma', async () => {
    expect(await run(gate(), [type('pa vault'), key('enter'), type('get más pan')])).toEqual([
      'allow',
      'allow',
      'allow',
    ]);
  });

  it('cada conversación tiene su línea', async () => {
    const g = gate();
    await g.check('otra', type('pa vault g'));
    expect((await g.check(S, type('et x'))).verdict).toBe('allow');
  });

  it.each([
    ['pa status', 'enter'],
    ['pa vault list', 'enter'],
    ['npx vitest run', 'enter'],
    ['quedamos pa (mañana) a las 5', 'enter'],
    ['hola, ¿qué tal?', 'tab'],
  ])('lo normal no cambia: %s', async (text, k) => {
    expect(await run(gate(), [type(text), key(k), type('ok')])).toEqual([
      'allow',
      'allow',
      'allow',
    ]);
  });
});

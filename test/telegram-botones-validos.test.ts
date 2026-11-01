import { describe, expect, it } from 'vitest';
import { buildKeyboard, usableButtons } from '../src/channels/telegram.js';

describe('botones que Telegram rechazaría no tumban el mensaje', () => {
  const ok = { label: 'Aprobar', action: 'approve:abc' };

  it('omite un botón con callback_data de más de 64 bytes', () => {
    const long = { label: 'Vigilar', action: `vigila:${'ñ'.repeat(40)}` };
    const kb = buildKeyboard([ok, long]);
    const data = kb.inline_keyboard
      .flat()
      .map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(data).toEqual(['approve:abc']);
  });

  it('omite botones sin texto o sin acción', () => {
    expect(usableButtons([ok, { label: '  ', action: 'x' }, { label: 'Y', action: '' }])).toEqual([
      ok,
    ]);
  });

  it('64 bytes justos sí valen', () => {
    const edge = { label: 'Z', action: 'a'.repeat(64) };
    expect(usableButtons([edge])).toEqual([edge]);
  });

  it('si no queda ninguno, la lista sale vacía (el mensaje va sin teclado)', () => {
    expect(usableButtons([{ label: 'X', action: 'b'.repeat(65) }])).toEqual([]);
  });
});

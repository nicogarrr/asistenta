import { describe, expect, it } from 'vitest';
import type { Message, Tool } from '@earendil-works/pi-ai';
import { parseReply, renderToolContract, renderTranscript } from '../src/core/opencode-local.js';

const hora: Tool = {
  name: 'hora',
  description: 'Devuelve la hora actual HH:MM',
  parameters: { type: 'object', properties: {}, required: [] },
} as Tool;

const clima: Tool = {
  name: 'clima',
  description: 'Tiempo en una ciudad',
  parameters: {
    type: 'object',
    properties: { ciudad: { type: 'string' }, dias: { type: 'number' } },
    required: ['ciudad'],
  },
} as Tool;

describe('parseReply', () => {
  const known = new Set(['hora', 'clima']);

  it('linea JSON de tool conocida -> toolCall con args', () => {
    const r = parseReply('{"tool":"clima","args":{"ciudad":"Gijon"}}', known);
    expect(r.kind).toBe('toolCall');
    expect(r.toolCall).toEqual({ name: 'clima', arguments: { ciudad: 'Gijon' } });
  });

  it('args ausente -> objeto vacio', () => {
    const r = parseReply('{"tool":"hora"}', known);
    expect(r.kind).toBe('toolCall');
    expect(r.toolCall?.arguments).toEqual({});
  });

  it('tool desconocida -> texto (nunca se inventa la llamada)', () => {
    const r = parseReply('{"tool":"borraTodo","args":{}}', known);
    expect(r.kind).toBe('text');
    expect(r.text).toContain('borraTodo');
  });

  it('JSON roto -> texto', () => {
    const r = parseReply('{"tool":"hora",', known);
    expect(r.kind).toBe('text');
  });

  it('respuesta normal -> texto tal cual', () => {
    const r = parseReply('Son las ocho y cuarto.', known);
    expect(r).toEqual({ kind: 'text', text: 'Son las ocho y cuarto.' });
  });

  it('JSON con tool no-string -> texto', () => {
    const r = parseReply('{"tool":42,"args":{}}', known);
    expect(r.kind).toBe('text');
  });
});

describe('renderToolContract', () => {
  it('sin tools -> cadena vacia', () => {
    expect(renderToolContract([])).toBe('');
  });

  it('lista specs con nombre, params y descripcion', () => {
    const c = renderToolContract([hora, clima]);
    expect(c).toContain('hora(');
    expect(c).toContain('clima(ciudad: string, dias?: number)');
    expect(c).toContain('{"tool":"nombre","args":{...}}');
  });
});

describe('renderTranscript', () => {
  it('serializa user, assistant text, toolCall y toolResult', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'prompt', timestamp: 1 },
      { role: 'user', content: 'que hora es?', timestamp: 2 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'voy a mirarlo' },
          { type: 'toolCall', id: 'c1', name: 'hora', arguments: {} },
        ],
        api: 'openai-completions', provider: 'opencode-local', model: 'm',
        usage: {} as never, stopReason: 'toolUse', timestamp: 3,
      },
      {
        role: 'toolResult', toolCallId: 'c1', toolName: 'hora',
        content: [{ type: 'text', text: '08:17' }], isError: false, timestamp: 4,
      },
    ];
    const t = renderTranscript(msgs);
    expect(t).not.toContain('prompt'); // el system va aparte
    expect(t).toContain('USUARIO: que hora es?');
    expect(t).toContain('ASISTENTA: voy a mirarlo');
    expect(t).toContain('ASISTENTA (llamada): {"tool":"hora","args":{}}');
    expect(t).toContain('RESULTADO hora: 08:17');
  });

  it('toolResult con error se marca', () => {
    const msgs: Message[] = [
      {
        role: 'toolResult', toolCallId: 'c1', toolName: 'clima',
        content: [{ type: 'text', text: 'timeout' }], isError: true, timestamp: 1,
      },
    ];
    expect(renderTranscript(msgs)).toContain('RESULTADO clima (ERROR): timeout');
  });

  it('imagenes se marcan como [imagen], nunca se omite el turno', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'mira esto' },
          { type: 'image', data: 'xx', mimeType: 'image/png' } as never,
        ],
        timestamp: 1,
      },
    ];
    const t = renderTranscript(msgs);
    expect(t).toContain('mira esto');
    expect(t).toContain('[imagen]');
  });
});

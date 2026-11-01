import { describe, expect, it } from 'vitest';
import { conversationStatus, formatStatus } from '../src/status.js';

const base = { version: 't', node: 'v24', uptimeMs: 0, tools: [], log: null, pageWatches: 0 };

describe('/estado: proyecto y modelo de esta conversación', () => {
  it('con proyecto ligado y cargado dice carpeta y fichero, sin ruta entera ni bytes; el modelo elegido se nota', () => {
    const lines = conversationStatus({
      projectDir: 'C:\\proyectos\\web',
      project: {
        ok: true,
        dir: 'C:\\proyectos\\web',
        file: 'x',
        name: 'AGENTS.md',
        text: 'hola',
        bytes: 812,
      },
      model: 'alt-model',
      primaryModel: 'main-model',
    });
    expect(lines).toEqual([
      'Proyecto: carpeta «web» (tengo en cuenta AGENTS.md).',
      'Modelo: alt-model (el que elegiste).',
    ]);
  });

  it('sin proyecto lo dice y explica cómo ligar uno; con carpeta rota dice por qué no carga', () => {
    expect(conversationStatus({ model: 'm', primaryModel: 'm' })).toEqual([
      'Proyecto: ninguno (/proyecto <carpeta> para ligar uno).',
      'Modelo: m (principal).',
    ]);
    const [p] = conversationStatus({
      projectDir: '/x',
      project: { ok: false, reason: 'la carpeta ya no existe' },
      model: 'm',
      primaryModel: 'm',
    });
    expect(p).toBe(
      'Proyecto: carpeta «x», pero ahora no puedo leer nada: la carpeta ya no existe.',
    );
  });

  it('formatStatus añade la sección solo cuando se la pasan (dueño en privado)', () => {
    expect(formatStatus(base)).not.toContain('Esta conversación');
    const text = formatStatus({
      ...base,
      conversation: ['Proyecto: ninguno.', 'Modelo: m (principal).'],
    });
    expect(text).toContain('Esta conversación:\n- Proyecto: ninguno.\n- Modelo: m (principal).');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { projectAnswer } from '../src/project-context.js';
import { conversationStatus } from '../src/status.js';

describe('/estado sin proyecto, en palabras', () => {
  it('no enseña «/proyecto <carpeta>»', () => {
    const [line] = conversationStatus({ model: 'm', primaryModel: 'm' });
    expect(line).not.toMatch(/\/proyecto|<carpeta>/);
    expect(line).toBe(
      'Proyecto: ninguno (si quieres que tenga en cuenta una carpeta, pégame su ruta).',
    );
  });

  it('la ruta pegada después liga la carpeta como /proyecto', () => {
    const q = new PreguntasPendientes(() => 0);
    q.ask('k', 'proyecto', { answer: projectAnswer });
    expect(q.consume('k', 'C:\\Proyectos\\web')).toEqual({
      name: 'proyecto',
      args: 'C:\\Proyectos\\web',
    });
  });

  it('/estado deja la pregunta abierta solo cuando no hay carpeta', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(
      /conversation = conversationStatus\(\{[^}]*\}\);\s*\/\/[^\n]*\n\s*if \(!projectContexts\.get\(thread\.key\)\) \{\s*preguntas\.ask\(chatKey\(inbound\), 'proyecto', \{ answer: projectAnswer \}\);/,
    );
  });
});

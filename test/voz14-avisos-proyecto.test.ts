import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { PACE_CHANGE_HINT, paceAnswer, paceText } from '../src/notice-pace.js';
import { projectAnswer, projectStateReply } from '../src/project-context.js';

const cli = readFileSync('src/cli.ts', 'utf8');

describe('ritmo de avisos en palabras', () => {
  it('el texto ya no enseña «/avisos menos | minimo | normal»', () => {
    for (const p of ['normal', 'menos', 'minimo'] as const) {
      const t = paceText(p);
      expect(t).not.toMatch(/\/avisos|\|/);
      expect(t.endsWith(PACE_CHANGE_HINT)).toBe(true);
    }
    expect(PACE_CHANGE_HINT).toBe(
      'Si lo quieres cambiar, dime «menos avisos», «solo lo importante» o «normal».',
    );
  });

  it.each([
    ['menos avisos', 'menos'],
    ['Menos avisos.', 'menos'],
    ['«solo lo importante»', 'minimo'],
    ['mínimo', 'minimo'],
    ['normal!', 'normal'],
    ['como antes', 'normal'],
  ])('«%s» → %s', (t, p) => {
    expect(paceAnswer(t)).toBe(p);
  });

  it.each(['', 'estado', 'gracias', 'menos mal que me avisas'])('«%s» no es respuesta', (t) => {
    expect(paceAnswer(t)).toBeNull();
  });

  it('la respuesta en palabras corre /avisos', () => {
    const q = new PreguntasPendientes(() => 0);
    q.ask('k', 'avisos', { answer: paceAnswer });
    expect(q.consume('k', 'solo lo importante')).toEqual({ name: 'avisos', args: 'minimo' });
  });

  it('/avisos y la bajada automática dejan la pregunta abierta', () => {
    expect(cli).toMatch(
      /preguntas\.ask\(chatKey\(inbound\), 'avisos', \{ answer: paceAnswer \}\);/,
    );
    expect(cli).toMatch(
      /if \(!res\.proposal\) preguntas\.ask\(chatKey\(inbound\), 'avisos', \{ answer: paceAnswer \}\);/,
    );
  });
});

describe('carpeta de proyecto en palabras', () => {
  it('el estado ya no enseña «/proyecto <carpeta>» ni «/proyecto quitar»', () => {
    const none = projectStateReply(undefined, undefined);
    expect(none).not.toMatch(/\/proyecto|<carpeta>/);
    expect(none).toContain('¿Quieres que tenga en cuenta una? Pégame la ruta de la carpeta.');
    const linked = projectStateReply('/home/nico/web', {
      ok: true,
      dir: '/home/nico/web',
      name: 'AGENTS.md',
      text: 'Web',
    } as never);
    expect(linked).not.toMatch(/\/proyecto|<carpeta>/);
    expect(linked).toContain('Si quieres quitarla, dime «quítala»');
  });

  it.each([
    ['quítala', 'quitar'],
    ['Quitala.', 'quitar'],
    ['quita la carpeta', 'quitar'],
    ['C:\\Proyectos\\web', 'C:\\Proyectos\\web'],
    ['«D:\\Mis cosas\\viaje»', 'D:\\Mis cosas\\viaje'],
    ['~/proyectos/web', '~/proyectos/web'],
    ['Proyectos\\web', 'Proyectos\\web'],
  ])('«%s» → %s', (t, a) => {
    expect(projectAnswer(t)).toBe(a);
  });

  it.each(['vale', 'la de la web', 'gracias, nada más'])('«%s» no es respuesta', (t) => {
    expect(projectAnswer(t)).toBeNull();
  });

  it('/proyecto deja la pregunta abierta en su chat', () => {
    expect(cli).toMatch(
      /preguntas\.ask\(chatKey\(inbound\), 'proyecto', \{ answer: projectAnswer \}\);\s*await say\(inbound, projectStateReply\(dir, ctx\)/,
    );
  });
});

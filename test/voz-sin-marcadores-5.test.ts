import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatPermisosLista } from '../src/channels/permisos-lista.js';
import { TV_CHAT_USAGE } from '../src/tv/tv-chat-command.js';

// Nico (1 nov): «conversaciones naturales, no usar cosas como <número o palabra>».
// /tv, /cron y /permisos lista enseñaban «Uso: /tv <orden>», «/cron del <nombre>»
// o «/permisos revocar <herramienta>». Ahora: pregunta normal con ejemplo real.
const MARCADOR = /<[a-záéíóúñ][^<>\n]{0,40}>|\bUso:|\[[a-z-]+\|[a-z|-]+\]/i;
const cron = readFileSync('src/daemon/cron-command.ts', 'utf8');

describe('respuestas naturales, sin <marcadores> (5): tele, rutinas programadas y permisos', () => {
  it('/tv sin orden: pregunta qué hacer y da ejemplos', () => {
    expect(TV_CHAT_USAGE).not.toMatch(MARCADOR);
    expect(TV_CHAT_USAGE).toMatch(
      /^¿Qué hago con la tele\? Dímelo con palabras, por ejemplo: \/tv apaga la tele/,
    );
  });

  it('/permisos lista: el ejemplo usa una herramienta de la lista', () => {
    const text = formatPermisosLista([{ tool: 'shell', chat: 'local', since: null }]);
    expect(text).not.toMatch(MARCADOR);
    expect(text).toContain('por ejemplo /permisos revocar shell');
  });

  it('/cron: ningún «Uso: /cron … <nombre>»', () => {
    expect(cron).not.toContain("'Uso: /cron");
    expect(cron).not.toContain('`Uso: /cron');
    expect(cron).toContain("'No tienes rutinas programadas que borrar.'");
    expect(cron).toContain('¿Qué hago y cuándo? Dímelo normal, por ejemplo: ');
  });
});

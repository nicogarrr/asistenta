import { describe, expect, it } from 'vitest';
import { formatBootNoticeResult } from '../src/boot-notice.js';
import { taintEmailTurn } from '../src/channels/email.js';
import { friendlyError } from '../src/channels/formatters.js';
import type { Routine } from '../src/db.js';
import { learnFromTurn } from '../src/memory/learned-rules.js';
import {
  type ProjectContext,
  projectLinkedReply,
  projectStateReply,
} from '../src/project-context.js';
import { lateReminderText } from '../src/tools/reminder.js';
import { mensajeDeError } from '../src/webui/client-format.js';

// Nico (31 oct): que Asistenta hable como en un chat. Los textos fijos que le llegan
// sin pasar por el modelo no deben llevar jerga interna, errores en crudo ni rutas.
const JERGA =
  /\bundefined\b|\bnull\b|\bNaN\b|Error:|TypeError|\bat \S+:\d+|[A-Za-z]:\\|\/home\/|\bturno\b|\bdaemon\b|fetch failed|ECONN|ETIMEDOUT|\{"/;

function routine(name: string, prompt: string): Pick<Routine, 'name' | 'prompt'> {
  return { name, prompt };
}

describe('textos fijos en lenguaje natural', () => {
  it('recordatorio con retraso: frase normal, con «a las»', () => {
    const t = lateReminderText(
      routine('recordatorio-1: comprar pan @2026-11-03 09:00', 'comprar pan'),
    );
    expect(t).toBe('⏰ Te lo recuerdo con retraso, era para el 03/11 a las 09:00: comprar pan');
    expect(t).not.toMatch(JERGA);
  });

  it('recordatorio con retraso sin hora conocida: sin «una hora anterior»', () => {
    const t = lateReminderText(routine('otra cosa', 'llamar a mamá'));
    expect(t).toBe('⏰ Te lo recuerdo con retraso: llamar a mamá');
  });

  const ERRORES: unknown[] = [
    new TypeError('fetch failed'),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    new Error('The operation was aborted due to timeout ETIMEDOUT'),
    new Error('429 Too Many Requests {"error":{"type":"rate_limit"}}'),
    new Error('401 invalid x-api-key'),
    new Error('503 Service Unavailable from model provider'),
    new TypeError("Cannot read properties of undefined (reading 'text')"),
    new Error('boom\n    at run (/home/nico/asistenta/dist/cli.js:12:3)'),
    new Error('{"detail":"something"}'),
    null,
    undefined,
  ];

  for (const err of ERRORES) {
    it(`friendlyError sin jerga: ${String((err as Error | null)?.message ?? err).slice(0, 40)}`, () => {
      const t = friendlyError(err);
      expect(t).not.toMatch(JERGA);
    });
  }
});

describe('/proyecto y aviso de arranque en lenguaje natural', () => {
  const ok: Extract<ProjectContext, { ok: true }> = {
    ok: true,
    dir: 'C:\\Users\\nico\\proyectos\\web',
    file: 'C:\\Users\\nico\\proyectos\\web\\AGENTS.md',
    name: 'AGENTS.md',
    text: '# Web de la tienda\nmás cosas',
    bytes: 812,
  };

  it('al ligar: sin ruta entera, sin bytes y sin «turno»', () => {
    const t = projectLinkedReply(ok);
    expect(t).toBe(
      'Hecho: en esta conversación tendré en cuenta AGENTS.md de la carpeta «web» («# Web de la tienda»).',
    );
    expect(t).not.toMatch(JERGA);
    expect(t).not.toMatch(/bytes/);
  });

  it('estado con carpeta ligada, sin carpeta y con carpeta rota', () => {
    const linked = projectStateReply(ok.dir, ok);
    expect(linked).toContain('tengo en cuenta AGENTS.md de la carpeta «web»');
    expect(projectStateReply(undefined, undefined)).toContain(
      'No hay ninguna carpeta de proyecto en esta conversación.',
    );
    const broken = projectStateReply('/home/nico/viaje', {
      ok: false,
      reason: 'AGENTS.md está vacío',
    });
    expect(broken).toContain(
      'Tengo ligada la carpeta «viaje», pero ahora no puedo leer nada: AGENTS.md está vacío.',
    );
    for (const t of [linked, broken]) {
      expect(t).not.toMatch(JERGA);
      expect(t).not.toMatch(/bytes|Uso:/);
    }
  });

  it('aviso de arranque que no se pudo enviar: sin «log del daemon»', () => {
    const t = formatBootNoticeResult(
      { result: 'failed', at: '2026-10-31T07:00:00.000Z' },
      new Date('2026-10-31T07:05:00.000Z'),
    );
    expect(t).toContain('no pude enviártelo por Telegram');
    expect(t).toContain('pa doctor');
    expect(t).not.toMatch(JERGA);
  });
});

describe('más textos fijos sin «turno» ni «registro»', () => {
  it('regla aprendida tras leer algo de fuera: frase normal', () => {
    const r = learnFromTurn({
      memory: {} as Parameters<typeof learnFromTurn>[0]['memory'],
      scope: 'telegram:dm:1#main',
      reply: 'Vale.\n[[aprendido: Sin emojis]]',
      hinted: true,
      tainted: true,
    });
    expect(r.line).toBe(
      '📝 No lo he guardado: acabo de leer algo de fuera (una web o un correo). Si quieres que lo aprenda, repítemelo.',
    );
    expect(r.line).not.toMatch(JERGA);
  });

  it('turno que llega por correo: la pregunta de permiso no dice «turno»', () => {
    const sources: string[] = [];
    taintEmailTurn(
      {
        markTainted: () => {},
        taintSessionPrivate: (_s, source) => sources.push(source),
      },
      's1',
    );
    expect(sources).toEqual(['el correo que acaba de llegar']);
    expect(sources[0]).not.toMatch(JERGA);
  });

  it('panel: un fallo del servidor se dice sin «error interno» ni «registro local»', () => {
    for (const estado of [500, 502]) {
      const t = mensajeDeError(estado, null);
      expect(t).toBe('Algo ha fallado por mi parte. Vuelve a intentarlo en un momento.');
      expect(t).not.toMatch(/interno|registro/i);
    }
  });
});

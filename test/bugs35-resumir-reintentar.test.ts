import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactForRetry, rewindLastTurn } from '../src/retry-turn.js';

// bugs-35 (revisión de #2317, tarjeta de error): «🗜️ Resumir y reintentar» resumía con el
// intento fallido DENTRO y luego llamaba a /reintentar, que ya no podía quitarlo (el resumen
// cambia los índices): el mensaje iba dos veces al modelo y el chat decía «El historial
// cambió desde entonces, así que la respuesta anterior se queda». Ahora el intento fallido
// sale antes de resumir.

const agent = {};
const fallido = () => ({
  agent,
  mark: 3,
  compactions: 0,
  text: '¿Me resumes el informe?',
});

describe('resumir y reintentar: el intento fallido no entra en el resumen', () => {
  it('lo de antes: resumir primero deja el intento fallido sin poder quitarse', () => {
    const messages = ['u1', 'a1', 'u2', 'u3 (falló)', 'error'];
    // Tras resumir cambian los resúmenes: rewindLastTurn ya no quita nada.
    expect(rewindLastTurn(fallido(), { agent, messages, compactions: 1 })).toBe(0);
  });

  it('quita el intento fallido, resume lo de antes y no lo devuelve', async () => {
    const messages = ['u1', 'a1', 'u2', 'u3 (falló)', 'error'];
    let visto: string[] = [];
    const { result, removed } = await compactForRetry(
      fallido(),
      { agent, messages, compactions: 0 },
      async () => {
        visto = [...messages];
        messages.splice(0, messages.length, 'resumen');
        return { compacted: true };
      },
    );
    expect(result.compacted).toBe(true);
    expect(removed).toBe(2);
    // El resumen no vio el mensaje que se va a repetir…
    expect(visto).toEqual(['u1', 'a1', 'u2']);
    // …y no vuelve: al repetirlo irá una sola vez.
    expect(messages).toEqual(['resumen']);
  });

  it('si no llega a resumir (o falla), el intento vuelve a su sitio', async () => {
    const messages = ['u1', 'a1', 'u2', 'u3 (falló)', 'error'];
    const r = await compactForRetry(fallido(), { agent, messages, compactions: 0 }, async () => ({
      compacted: false,
    }));
    expect(r.removed).toBe(0);
    expect(messages).toEqual(['u1', 'a1', 'u2', 'u3 (falló)', 'error']);
    await expect(
      compactForRetry(fallido(), { agent, messages, compactions: 0 }, async () => {
        throw new Error('sin red');
      }),
    ).rejects.toThrow('sin red');
    expect(messages).toEqual(['u1', 'a1', 'u2', 'u3 (falló)', 'error']);
  });

  it('otro agente u otro resumen ya hecho: no toca nada antes de resumir', async () => {
    const messages = ['u1', 'a1', 'u2', 'u3', 'x'];
    let visto = 0;
    await compactForRetry(fallido(), { agent: {}, messages, compactions: 0 }, async () => {
      visto = messages.length;
      return { compacted: true };
    });
    expect(visto).toBe(5);
  });

  it('cli: /compactar reintentar usa compactForRetry y no reenvía a /reintentar', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = src.indexOf('const cmdCompactar = async');
    const body = src.slice(i, src.indexOf('\n  };\n', i));
    expect(body).toContain('compactForRetry(');
    expect(body).not.toContain('cmdReintentar(');
  });
});

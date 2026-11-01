import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERASE_BUSY_ASK } from '../src/erase-command.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('/borrar_chat con una tarea en marcha', () => {
  it('no manda a /stop ni a /borrar_chat: pregunta si la para y lo borra', () => {
    expect(ERASE_BUSY_ASK).toBe(
      'Hay una tarea en marcha en este chat, así que no he borrado nada. ¿La paro y lo borro todo? Dime «sí».',
    );
    expect(ERASE_BUSY_ASK).not.toMatch(/\/\w/);
    expect(cli).not.toContain('Usa /stop y vuelve a pedir /borrar_chat');
    expect(cli).toContain('eraseAfterStop.set(ck, Date.now());');
  });

  it('el «sí» para la tarea, espera a que suelte el chat y borra; otra cosa no borra', () => {
    const start = cli.indexOf('const stopAndEraseByWords = async');
    const body = cli.slice(start, cli.indexOf('// F13:', start));
    expect(body).toContain('eraseAfterStop.delete(ck);');
    expect(body).toContain(
      'if (Date.now() - at > 2 * 60_000 || !SI_RESPUESTA.test(inbound.text.trim())) return false;',
    );
    expect(body.indexOf('await cmdStop(inbound);')).toBeLessThan(
      body.indexOf('await cmdBorrarChatConfirmado(inbound);'),
    );
    expect(body).toContain('t.chatKey === ck && t.active');
    expect(cli).toContain('if (await stopAndEraseByWords(inbound)) return;');
  });
});

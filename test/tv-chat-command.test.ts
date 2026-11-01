/**
 * `/tv <orden>`: orden directa a la tele sin modelo, solo para el dueño en
 * privado, por la tool tv (action=command) contra la tele falsa.
 */

import { describe, expect, it, vi } from 'vitest';
import { TV_CHAT_USAGE, tvChatCommand } from '../src/tv/tv-chat-command.js';

describe('tvChatCommand', () => {
  it('sin orden: uso con ejemplos, sin ejecutar nada', async () => {
    const run = vi.fn();
    expect(await tvChatCommand('  ', { isOwner: true, run })).toBe(TV_CHAT_USAGE);
    expect(run).not.toHaveBeenCalled();
  });

  it('quien no es el dueño en privado no manda en la tele', async () => {
    const run = vi.fn();
    const out = await tvChatCommand('apaga la tele', { isOwner: false, run });
    expect(out).toContain('Solo el dueño');
    expect(run).not.toHaveBeenCalled();
  });

  it('orden no entendida: lo dice y NO la ejecuta (ni la manda al modelo)', async () => {
    const run = vi.fn();
    const out = await tvChatCommand('hazme un café', { isOwner: true, run });
    expect(out).toContain('No he entendido «hazme un café»');
    expect(out).toContain('«abre Netflix»');
    expect(run).not.toHaveBeenCalled();
  });

  it('orden demasiado larga: rechazada', async () => {
    const run = vi.fn();
    const out = await tvChatCommand(`apaga la tele ${'x'.repeat(300)}`, { isOwner: true, run });
    expect(out).toContain('demasiado larga');
    expect(run).not.toHaveBeenCalled();
  });

  it('orden simple: pasa el texto tal cual a la tool y devuelve su respuesta', async () => {
    const run = vi.fn(async () => 'He apagado la tele.');
    const out = await tvChatCommand(' apaga la tele ', { isOwner: true, run });
    expect(run).toHaveBeenCalledWith('apaga la tele');
    expect(out).toBe('He apagado la tele.');
  });

  it('respuesta vacía: confirma con la descripción', async () => {
    const out = await tvChatCommand('abre netflix', { isOwner: true, run: async () => '' });
    expect(out).toMatch(/^Hecho: /);
  });

  it('error de la tele: explicado en castellano, sin lanzar', async () => {
    const out = await tvChatCommand('apaga la tele', {
      isOwner: true,
      run: async () => {
        throw new Error('No llego a la tele.');
      },
    });
    expect(out).toBe('No he podido apagar la tele: No llego a la tele.');
  });
});

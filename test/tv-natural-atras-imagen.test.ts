import { describe, expect, it } from 'vitest';
import { describeTvIntent, parseTvCommand, tvIntentNotice } from '../src/tv/natural.js';
import { tvChatCommand } from '../src/tv/tv-chat-command.js';
import { tvCommand } from '../src/tv/tv-cli.js';

describe('natural: «vuelve atrás» pulsa BACK', () => {
  for (const s of [
    'vuelve atrás',
    'atrás',
    'dale atrás',
    'pulsa el botón de atrás',
    'vuelve atrás en la tele',
    'dale al botón de atrás',
  ]) {
    it(s, () => {
      expect(parseTvCommand(s)).toStrictEqual({ action: 'key', name: 'BACK' });
    });
  }
  it('«vuelve al canal anterior» no es la tecla atrás', () => {
    expect(parseTvCommand('vuelve al canal anterior')).not.toStrictEqual({
      action: 'key',
      name: 'BACK',
    });
  });
  it('se describe en castellano', () => {
    expect(describeTvIntent({ action: 'key', name: 'BACK' })).toBe('volver atrás');
  });
});

describe('natural: «sube 20» avisa del recorte a 15', () => {
  it('sube 20 → 15 con lo pedido', () => {
    expect(parseTvCommand('sube 20')).toStrictEqual({
      action: 'volumeStep',
      steps: 15,
      requested: 20,
    });
    expect(parseTvCommand('baja el volumen 30')).toStrictEqual({
      action: 'volumeStep',
      steps: -15,
      requested: 30,
    });
  });
  it('sube 5 no lleva aviso', () => {
    const i = parseTvCommand('sube 5');
    expect(i).toStrictEqual({ action: 'volumeStep', steps: 5 });
    expect(i && tvIntentNotice(i)).toBeNull();
  });
  it('el aviso y la descripción dicen el recorte', () => {
    const i = parseTvCommand('sube 20');
    expect(i).not.toBeNull();
    if (!i) return;
    expect(tvIntentNotice(i)).toBe(
      'Pediste subir 20, pero de una vez subo como mucho 15: lo he subido 15.',
    );
    expect(describeTvIntent(i)).toBe(
      'subir el volumen 15 (pediste 20; el máximo de una vez es 15)',
    );
  });
});

describe('natural: modo de imagen por voz', () => {
  const casos: [string, string][] = [
    ['pon la imagen en estándar', 'standard'],
    ['imagen normal', 'standard'],
    ['pon la imagen oscura', 'eco'],
    ['cambia la imagen a modo ahorro', 'eco'],
    ['pon la imagen en modo cine', 'cinema'],
    ['imagen viva', 'vivid'],
    ['pon el modo de imagen juego', 'game'],
    ['imagen de deportes en la tele', 'sports'],
  ];
  for (const [s, mode] of casos) {
    it(s, () => {
      expect(parseTvCommand(s)).toStrictEqual({ action: 'picture', pictureMode: mode });
    });
  }
  it('«modo cine» sigue siendo la rutina (no cambia la imagen)', () => {
    expect(parseTvCommand('pon el modo cine')).toStrictEqual({ action: 'scene', scene: 'cine' });
  });
  it('un modo desconocido no se adivina', () => {
    expect(parseTvCommand('pon la imagen rosa')).toBeNull();
  });
  it('se describe en castellano', () => {
    expect(describeTvIntent({ action: 'picture', pictureMode: 'standard' })).toBe(
      'poner la imagen en modo estándar',
    );
  });
});

describe('el aviso del recorte llega a la respuesta', () => {
  it('/tv sube 20 añade el aviso a lo que contesta la tele', async () => {
    const run = async () => 'Volumen: 30.';
    const r = await tvChatCommand('sube 20', { isOwner: true, run });
    expect(r).toBe(
      'Volumen: 30.\nPediste subir 20, pero de una vez subo como mucho 15: lo he subido 15.',
    );
  });
  it('/tv sube 5 no añade nada', async () => {
    const run = async () => 'Volumen: 20.';
    expect(await tvChatCommand('sube 5', { isOwner: true, run })).toBe('Volumen: 20.');
  });
});

describe('pa tv orden: aviso del recorte', () => {
  it('«pa tv orden sube 20» imprime lo que hizo y el aviso', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const runOrder = async () => 'Volumen: 30.';
    const code = await tvCommand(['orden', 'sube', '20'], {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      runOrder,
    });
    expect(code).toBe(0);
    expect(out.join('')).toBe(
      'Volumen: 30.\nPediste subir 20, pero de una vez subo como mucho 15: lo he subido 15.\n',
    );
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  imageDataUrl,
  PANEL_MAX_IMAGES,
  runPanelChat,
  type TurnOutput,
} from '../src/daemon/panel-chat.js';
import { ThreadOutputs, threadContext } from '../src/daemon/thread-context.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('contexto por conversación: capturas de un turno del panel', () => {
  it('en un turno del panel la captura va al panel y nada sale por Telegram', async () => {
    const outputs = new ThreadOutputs();
    const photos: Buffer[] = [];
    const out: TurnOutput = { answer: () => {}, note: () => {}, photo: (b) => photos.push(b) };
    const ctx = threadContext({ key: 'k', outputs, gate: () => 'ok' });
    const telegram = vi.fn(async () => true);
    outputs.bind('k', out);
    expect(await ctx.sendPhoto(PNG, telegram)).toBe(true);
    expect(telegram).not.toHaveBeenCalled();
    expect(photos).toEqual([PNG]);
  });

  it('sin turno del panel es exactamente el envío por Telegram (resultado y errores)', async () => {
    const outputs = new ThreadOutputs();
    const ctx = threadContext({ key: 'k', outputs, gate: null });
    expect(await ctx.sendPhoto(PNG, async () => false)).toBe(false);
    await expect(
      ctx.sendPhoto(PNG, async () => {
        throw new Error('telegram caído');
      }),
    ).rejects.toThrow('telegram caído');
    // Un turno de Telegram tras uno del panel vuelve al canal.
    const panel: TurnOutput = { answer: () => {}, note: () => {}, photo: () => {} };
    outputs.bind('k', panel);
    outputs.bind('k', undefined);
    const telegram = vi.fn(async () => true);
    await ctx.sendPhoto(PNG, telegram);
    expect(telegram).toHaveBeenCalledTimes(1);
  });

  it('al acabar el turno del panel se suelta; otro hilo nunca usa la salida ajena', async () => {
    const outputs = new ThreadOutputs();
    const photo = vi.fn();
    const out: TurnOutput = { answer: () => {}, note: () => {}, photo };
    outputs.bind('panel', out);
    const other = threadContext({ key: 'otro', outputs, gate: null });
    const telegram = vi.fn(async () => true);
    await other.sendPhoto(PNG, telegram);
    expect(telegram).toHaveBeenCalledTimes(1);
    outputs.release('panel', out);
    await threadContext({ key: 'panel', outputs, gate: null }).sendPhoto(PNG, telegram);
    expect(telegram).toHaveBeenCalledTimes(2);
    expect(photo).not.toHaveBeenCalled();
    // release de una salida ya sustituida no borra la nueva
    const newer: TurnOutput = { answer: () => {}, note: () => {}, photo: () => {} };
    outputs.bind('panel', newer);
    outputs.release('panel', out);
    expect(outputs.get('panel')).toBe(newer);
  });

  it('el gate del contexto es el del hilo', () => {
    const gate = vi.fn();
    expect(threadContext({ key: 'k', outputs: new ThreadOutputs(), gate }).gate).toBe(gate);
  });
});

describe('runPanelChat devuelve las imágenes del turno', () => {
  const thread = () => ({ key: 'main', generation: 0, tail: Promise.resolve(), active: false });

  it('una captura durante el turno vuelve como data: PNG junto al texto', async () => {
    const res = await runPanelChat(thread(), 'haz captura', {
      remember: () => {},
      runTurn: async (_t, _s, out) => {
        out.photo?.(PNG);
        out.answer('Aquí tienes');
      },
    });
    expect(res.text).toBe('Aquí tienes');
    expect(res.images).toEqual([`data:image/png;base64,${PNG.toString('base64')}`]);
  });

  it('sin imágenes la respuesta no cambia; más del tope se cuentan; no-imagen no se muestra', async () => {
    const plain = await runPanelChat(thread(), 'hola', {
      remember: () => {},
      runTurn: async (_t, _s, out) => out.answer('hola'),
    });
    expect(plain).toEqual({ text: 'hola' });
    const many = await runPanelChat(thread(), 'x', {
      remember: () => {},
      runTurn: async (_t, _s, out) => {
        for (let i = 0; i < PANEL_MAX_IMAGES + 1; i++) out.photo?.(PNG);
        out.photo?.(Buffer.from('not an image'));
        out.answer('ok');
      },
    });
    expect(many.images).toHaveLength(PANEL_MAX_IMAGES);
    expect(many.text).toContain('2 imagen(es) más');
    expect(imageDataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });
});

describe('cableado en cli.ts', () => {
  const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  it('Computer Use y el navegador mandan capturas por el contexto del hilo', () => {
    expect(src).toMatch(/\.\.\.computerPlugin\.tools\(\{\s*config,\s*screen,\s*ctx,/);
    expect(src).toMatch(
      /createBrowserTool\(browserFor\(thread\.key\), scope, \(png\) =>\s*ctx\.sendPhoto\(/,
    );
  });
  it('runTurn ata la salida del turno al hilo y la suelta en el finally', () => {
    expect(src).toContain('threadOutputs.bind(thread.key, out);');
    expect(src).toContain('threadOutputs.release(thread.key, out);');
  });
});

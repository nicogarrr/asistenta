import WebSocket from 'ws';
import {
  assertTvHost,
  parseTvUrl,
  type TvClientDeps,
  type TvInputSocket,
  type TvInputSocketFactory,
  tvRequest,
} from '../tv/lgtv.js';
import type { AimSink } from './engine.js';

/** Pantalla virtual para la proyección: el puntero de la LG se mueve en relativo. */
export const TELE_SCREEN = { w: 1920, h: 1080 };
/** Un toque más corto que esto es un clic; más largo, un arrastre. */
export const TELE_CLICK_MAX_S = 0.4;

/**
 * Puntero de la LG por el socket de input de SSAP (el de los botones del mando):
 * `type:move\ndx:..\ndy:..\ndown:0|1\n\n`, `type:click\n\n`, `type:scroll\ndx:0\ndy:..\n\n`,
 * `type:button\nname:BACK\n\n`. Lo usan aiowebostv y pywebostv.
 * shortcut: no probado en la tele de Nico (hace falta una ventana suya); los píxeles de dx/dy
 * no son los de la pantalla: `speed` los escala y se ajusta en la prueba.
 */
export class TeleSink implements AimSink {
  readonly absolute = false;
  readonly screen = TELE_SCREEN;
  private carryX = 0;
  private carryY = 0;
  private dragging = false;

  private readonly ws: TvInputSocket;
  private readonly speed: number;

  private constructor(ws: TvInputSocket, speed: number) {
    this.ws = ws;
    this.speed = speed;
  }

  static async open(
    host: string,
    clientKey: string,
    deps: TvClientDeps = {},
    speed = 1,
  ): Promise<TeleSink> {
    const safeHost = assertTvHost(host, deps.allowNonLanHost ?? false);
    const res = await tvRequest(
      safeHost,
      clientKey,
      'com.webos.service.networkinput/getPointerInputSocket',
      {},
      deps,
    );
    const url = parseTvUrl((res as { socketPath?: unknown }).socketPath, safeHost, ['ws:', 'wss:']);
    if (!url) throw new Error('La tele devolvió un socket de puntero no válido.');
    const factory: TvInputSocketFactory =
      deps.inputFactory ??
      ((u) => new WebSocket(u, { rejectUnauthorized: false }) as unknown as TvInputSocket);
    const ws = factory(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('La tele no abrió el socket de puntero.')),
        5_000,
      );
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', () => {
        clearTimeout(timer);
        reject(new Error('Error abriendo el socket de puntero de la tele.'));
      });
    });
    return new TeleSink(ws, speed);
  }

  private send(frame: string): void {
    this.ws.send(frame);
  }

  moveBy(dx: number, dy: number, dragging: boolean): void {
    this.carryX += dx * this.speed;
    this.carryY += dy * this.speed;
    const ix = Math.trunc(this.carryX);
    const iy = Math.trunc(this.carryY);
    if (ix === 0 && iy === 0) return;
    this.carryX -= ix;
    this.carryY -= iy;
    this.send(`type:move\ndx:${ix}\ndy:${iy}\ndown:${dragging ? 1 : 0}\n\n`);
  }
  down(): void {
    this.dragging = true;
  }
  up(held: number): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (held <= TELE_CLICK_MAX_S) this.send('type:click\n\n');
  }
  right(): void {
    // La tele no tiene clic derecho: el equivalente del mando es Atrás.
    this.send('type:button\nname:BACK\n\n');
  }
  scroll(dy: number): void {
    const n = Math.round(Math.max(-500, Math.min(500, dy)));
    if (n !== 0) this.send(`type:scroll\ndx:0\ndy:${n}\n\n`);
  }
  close(): void {
    this.ws.close();
  }
}

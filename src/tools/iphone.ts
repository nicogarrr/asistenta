import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { type IphoneStatus, readiness } from '../iphone/client.js';
import { log } from '../log.js';

/**
 * Herramienta del iPhone (esp32-iphone-agent).
 *
 * El servidor `hidagent` ve el telefono por AirPlay y lo toca con una ESP32
 * que hace de raton USB; el modelo de vision que decide cada toque vive EN ESE
 * SERVIDOR (ver deploy/iphone). Esta herramienta solo le da un objetivo, lo
 * vigila y devuelve la pantalla.
 *
 * Sin prueba de efecto completo: `run` mueve un telefono real con cuentas
 * reales, asi que el gestor lo trata como opaco y SIEMPRE pregunta. Solo
 * `status` y `screenshot` son lecturas.
 */

export interface IphoneToolDeps {
  status: () => Promise<IphoneStatus>;
  frame: () => Promise<Buffer>;
  start: (goal: string) => Promise<void>;
  stop: () => Promise<void>;
  home: () => Promise<void>;
  /** Pausa entre sondeos; los tests la sustituyen. */
  sleep?: (ms: number) => Promise<void>;
}

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('status'),
    Type.Literal('screenshot'),
    Type.Literal('run'),
    Type.Literal('stop'),
    Type.Literal('home'),
  ]),
  goal: Type.Optional(
    Type.String({
      description:
        'Para run: el objetivo en lenguaje natural ("abre Ajustes y ve a Wi-Fi"). Una tarea concreta y acotada.',
    }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({
      description:
        'Para run: cuanto esperar a que termine (0-600, por defecto 120). 0 = no esperar.',
    }),
  ),
});

const POLL_MS = 3000;
const MAX_WAIT_S = 600;
const DEFAULT_WAIT_S = 120;

/** Las acciones sobre el telefono van de una en una: dos agentes no se pisan. */
let queue: Promise<void> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const text = (t: string) => ({ type: 'text' as const, text: t });

export function createIphoneTool(deps: IphoneToolDeps): AgentTool<typeof Params> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    name: 'iphone',
    label: 'iPhone',
    description: [
      'Maneja el iPhone real de Nico a traves de una ESP32 (raton USB) y su pantalla por AirPlay.',
      'action=status dice si el puente esta listo (ESP32 conectada, pantalla en directo, puntero calibrado)',
      'y si hay una tarea en marcha. Mira SIEMPRE el status antes de lanzar nada.',
      'action=screenshot devuelve la pantalla del telefono ahora mismo.',
      'action=run con goal le da una tarea al agente del telefono y espera (waitSeconds) a que acabe;',
      'devuelve cuantos pasos dio y la pantalla final. Es un agente aparte con su propio modelo:',
      'puede equivocarse o no terminar. Comprueba el resultado con la captura final, no con su palabra.',
      'action=stop es la parada de emergencia, action=home vuelve a la pantalla de inicio.',
      'Limites: solo ve pixeles (no lee notificaciones ni el estado interno); si el telefono se bloquea o',
      'se corta el AirPlay, la tarea se queda parada. Nunca introduzcas contrasenas ni codigos por aqui',
      'salvo que Nico lo pida en esta conversacion.',
    ].join(' '),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'status': {
          const s = await deps.status();
          const missing = readiness(s);
          const lines = [
            missing.length
              ? `NO listo: ${missing.join('; ')}.`
              : 'Listo: ESP32 conectada, pantalla en directo y puntero calibrado.',
            s.agent.running
              ? `Tarea en marcha: "${s.agent.task ?? ''}" (${s.agent.steps} pasos).`
              : 'Sin tarea en marcha.',
            s.models.actor
              ? `Modelo actor: ${s.models.actor}; planificador: ${s.models.planner}.`
              : 'Modelo no configurado.',
          ];
          return {
            content: [text(lines.join(' '))],
            details: { ...s, ready: missing.length === 0 },
          };
        }
        case 'screenshot': {
          const image = await deps.frame();
          return {
            content: [
              text(`Pantalla del iPhone (${image.length} bytes).`),
              { type: 'image' as const, mimeType: 'image/jpeg', data: image.toString('base64') },
            ],
            details: { bytes: image.length },
          };
        }
        case 'run': {
          const goal = (args.goal ?? '').trim();
          if (!goal)
            throw new Error('action=run necesita goal: una tarea concreta para el telefono.');
          const waitS = Math.min(Math.max(args.waitSeconds ?? DEFAULT_WAIT_S, 0), MAX_WAIT_S);
          return enqueue(async () => {
            const before = await deps.status();
            const missing = readiness(before);
            if (missing.length) {
              throw new Error(`El iPhone no esta listo: ${missing.join('; ')}.`);
            }
            if (before.agent.running) {
              throw new Error(
                `Ya hay una tarea en marcha en el telefono ("${before.agent.task ?? ''}"). Espera o usa action=stop.`,
              );
            }
            await deps.start(goal);
            log.info('iphone run', { goal, waitS });
            const deadline = Date.now() + waitS * 1000;
            let last = before;
            // Primer sondeo tras arrancar: el servidor marca running de forma asincrona.
            // waitS=0: no espera, ni siquiera un sondeo.
            while (waitS > 0 && Date.now() < deadline) {
              await sleep(POLL_MS);
              last = await deps.status();
              if (!last.agent.running) break;
            }
            const finished = waitS > 0 && !last.agent.running;
            let shot: Buffer | null = null;
            try {
              shot = await deps.frame();
            } catch {
              shot = null;
            }
            const summary = finished
              ? `El agente del telefono ha parado tras ${last.agent.steps} pasos. Que pare NO prueba que haya cumplido el objetivo: mira la captura.`
              : `Sigue en marcha tras ${waitS}s (${last.agent.steps} pasos). Usa action=status o action=screenshot para seguirla, o action=stop.`;
            return {
              content: [
                text(summary),
                ...(shot
                  ? [
                      {
                        type: 'image' as const,
                        mimeType: 'image/jpeg',
                        data: shot.toString('base64'),
                      },
                    ]
                  : [text('No pude capturar la pantalla final.')]),
              ],
              details: { goal, finished, steps: last.agent.steps, verified: false },
            };
          });
        }
        case 'stop': {
          await enqueue(() => deps.stop());
          return { content: [text('Parada de emergencia enviada al telefono.')], details: {} };
        }
        case 'home': {
          await enqueue(() => deps.home());
          return {
            content: [text('He pulsado Inicio en el iPhone (sin confirmacion de la pantalla).')],
            details: {},
          };
        }
        default:
          throw new Error('action desconocida.');
      }
    },
  };
}

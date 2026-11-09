import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { type IphoneStatus, readiness, setupGuide } from '../iphone/client.js';
import {
  abrirApp,
  BloqueadoError,
  comboValido,
  desplazar,
  escribirTexto,
  exigeDesbloqueado,
  type ManosIphone,
  type OjosIphone,
} from '../iphone/gestos.js';
import { esperarQuieta, firmaLineas } from '../iphone/quieta.js';
import {
  buscarTexto,
  formatearPantalla,
  lineasDePantalla,
  pantallaBloqueada,
  zonaProhibida,
} from '../iphone/texto.js';
import { log } from '../log.js';
import type { OcrResult } from '../screen/ocr.js';

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
  /**
   * OCR de una captura JPEG (en el PC, el de Windows: src/screen/ocr.ts). Sin él,
   * action=texto explica que no puede leer y remite a screenshot.
   */
  ocr?: (jpeg: Buffer) => Promise<OcrResult>;
  /**
   * Pasos sueltos (PA_IPHONE_GESTOS=1): tocar, deslizar, escribir, teclas y atrás en el
   * servidor hidagent. Sin ellos (o sin `gestos`), esas acciones explican cómo activarlas.
   */
  gestos?: boolean;
  manos?: ManosIphone & { back(): Promise<void> };
  /** Pausa entre sondeos; los tests la sustituyen. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * De dónde salen las manos: el puente ESP32 (hidagent, por defecto) o el Bluetooth del
   * propio PC con Windows (PA_IPHONE_BLE=1, src/iphone/ble.ts). Cambia los textos y qué
   * cuenta como «listo»; las guardas de cada paso son las mismas.
   */
  modo?: 'esp32' | 'ble';
  /** Qué falta para actuar (vacío = listo). Por defecto, el de hidagent (`readiness`). */
  faltan?: (s: IphoneStatus) => string[];
  /** Alta guiada propia del modo (por defecto, la de hidagent). */
  guia?: typeof setupGuide;
}

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('status'),
      Type.Literal('setup'),
      Type.Literal('screenshot'),
      Type.Literal('texto'),
      Type.Literal('tocar'),
      Type.Literal('tocar_texto'),
      Type.Literal('escribir'),
      Type.Literal('tecla'),
      Type.Literal('atras'),
      Type.Literal('desplazar'),
      Type.Literal('abrir_app'),
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
    todo: Type.Optional(
      Type.Boolean({
        description:
          'Para texto: true incluye la barra de estado y los iconos que el OCR lee como letras.',
      }),
    ),
    x: Type.Optional(
      Type.Number({ description: 'Para tocar: x en fraccion del ancho (0 a 1), como en texto.' }),
    ),
    y: Type.Optional(
      Type.Number({ description: 'Para tocar: y en fraccion del alto (0 a 1), como en texto.' }),
    ),
    texto: Type.Optional(
      Type.String({
        description:
          'Para tocar_texto: el texto que se ve en pantalla («Wi-Fi»). Para escribir: lo que se escribe (sin tildes ni enes; \\n = Intro).',
      }),
    ),
    combo: Type.Optional(
      Type.String({ description: 'Para tecla: enter, backspace, esc, tab, cmd+a, cmd+h...' }),
    ),
    direccion: Type.Optional(
      Type.Union([Type.Literal('abajo'), Type.Literal('arriba')], {
        description: 'Para desplazar: abajo o arriba.',
      }),
    ),
    cantidad: Type.Optional(
      Type.Number({ description: 'Para desplazar: medias pantallas (0.5 a 2, por defecto 1).' }),
    ),
    app: Type.Optional(
      Type.String({
        description: 'Para abrir_app: el nombre como sale en el iPhone («WhatsApp»).',
      }),
    ),
    waitSeconds: Type.Optional(
      Type.Number({
        description:
          'Para run: cuanto esperar a que termine (0-600, por defecto 60). 0 = no esperar.',
      }),
    ),
  }),
);

const POLL_MS = 3000;
/**
 * Sin OCR, lo que se deja al telefono para mostrar el resultado de un paso. Con OCR se
 * espera a que la pantalla se quede quieta (src/iphone/quieta.ts).
 */
export const PAUSA_TRAS_PASO_MS = 800;

type PasoArgs = {
  action: string;
  x?: number;
  y?: number;
  texto?: string;
  combo?: string;
  direccion?: 'abajo' | 'arriba';
  cantidad?: number;
  app?: string;
};
const MAX_WAIT_S = 600;
const DEFAULT_WAIT_S = 60;

/**
 * Los `run` van de uno en uno: dos agentes no se pisan. Las PARADAS (stop, home)
 * no pasan por aqui a proposito.
 */
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

export function createIphoneTool(deps: IphoneToolDeps): AgentTool<ReturnType<typeof Params>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ble = deps.modo === 'ble';
  const faltan = deps.faltan ?? readiness;
  const guia = deps.guia ?? setupGuide;

  /** La pantalla en texto (con la barra de estado, para reconocer el bloqueo), o null sin OCR. */
  let firmaPrevia: string | null = null;
  const ojos: OjosIphone = async () => {
    if (!deps.ocr) return null;
    const ocr = await deps.ocr(await deps.frame());
    firmaPrevia = firmaLineas(lineasDePantalla(ocr));
    return lineasDePantalla(ocr, { todo: true });
  };

  /**
   * Un paso suelto en el teléfono. Antes de mandar nada: activado, puente listo, sin el
   * agente del servidor en marcha (se pisarían) y los controles de cada acción. Un fallo
   * AL MANDAR deja la duda de si se hizo: se dice así, para mirar antes de repetir.
   */
  async function paso(args: PasoArgs) {
    const manos = deps.manos;
    if (!deps.gestos || !manos) {
      throw new Error(
        'Los pasos sueltos en el iPhone estan apagados. Se activan con PA_IPHONE_GESTOS=1 en .env; mientras, usa action=run con un objetivo.',
      );
    }
    const s = await deps.status();
    const missing = faltan(s);
    if (missing.length) throw new Error(`El iPhone no esta listo: ${missing.join('; ')}.`);
    if (s.agent.running) {
      throw new Error(
        `El agente del telefono esta en marcha ("${s.agent.task ?? ''}"): espera o usa action=stop antes de dar pasos sueltos.`,
      );
    }
    let enviando = false;
    const mano =
      <A extends unknown[]>(f: (...a: A) => Promise<void>) =>
      async (...a: A) => {
        enviando = true;
        await f(...a);
      };
    const m: ManosIphone = {
      tap: mano((x: number, y: number) => manos.tap(x, y)),
      swipe: mano((a: number, b: number, c: number, d: number) => manos.swipe(a, b, c, d)),
      type: mano((t: string) => manos.type(t)),
      key: mano((k: string) => manos.key(k)),
    };
    let hecho: string;
    try {
      switch (args.action) {
        case 'tocar': {
          const x = args.x;
          const y = args.y;
          if (typeof x !== 'number' || typeof y !== 'number')
            throw new Error(
              'Para tocar hacen falta x e y (fracciones de 0 a 1, como en action=texto).',
            );
          const prohibida = zonaProhibida(x, y);
          if (prohibida) throw new Error(prohibida);
          // Mirar si está bloqueado es lo mejor posible aquí: sin OCR (o si falla) se toca igual.
          const lineas = await ojos().catch(() => null);
          if (lineas && pantallaBloqueada(lineas)) throw new BloqueadoError();
          await m.tap(x, y);
          hecho = `Tocado en (${x}, ${y}).`;
          break;
        }
        case 'tocar_texto': {
          const lineas = await ojos();
          if (lineas === null) {
            throw new Error(
              'Sin el OCR de Windows no puedo buscar texto en la pantalla: mira action=screenshot y usa tocar con x e y.',
            );
          }
          if (pantallaBloqueada(lineas)) throw new BloqueadoError();
          const b = buscarTexto(lineas, args.texto ?? '');
          if (!b.ok) {
            if (b.motivo === 'vacio')
              throw new Error('Para tocar_texto hace falta el texto que se ve.');
            if (b.motivo === 'ambiguo') {
              const lista = b.candidatas
                .slice(0, 5)
                .map((l) => `«${l.texto}» (${l.x}, ${l.y})`)
                .join(', ');
              throw new Error(
                `Hay varias lineas con ese texto: ${lista}. No toco ninguna: usa tocar con la x y de la que quieras.`,
              );
            }
            throw new Error(
              `«${args.texto}» no sale como texto en la pantalla, asi que no he tocado nada. Baja con desplazar o, si es un icono, mira action=screenshot y usa tocar con x e y.`,
            );
          }
          const prohibida = zonaProhibida(b.linea.x, b.linea.y);
          if (prohibida) throw new Error(prohibida);
          await m.tap(b.linea.x, b.linea.y);
          hecho = `Tocado «${b.linea.texto}» en (${b.linea.x}, ${b.linea.y})${b.como === 'parecido' ? ' (el OCR lo leia parecido: comprueba que era eso)' : ''}.`;
          break;
        }
        case 'escribir':
          await escribirTexto(m, ojos, args.texto ?? '');
          hecho = 'Escrito.';
          break;
        case 'tecla': {
          const combo = (args.combo ?? '').trim().toLowerCase();
          if (!comboValido(combo)) {
            throw new Error(
              'Tecla no valida. Valen enter, backspace, esc, tab, space, flechas, una letra o numero, con cmd/ctrl/alt/shift delante (cmd+a).',
            );
          }
          await exigeDesbloqueado(ojos);
          await m.key(combo);
          hecho = `Pulsado ${combo}.`;
          break;
        }
        case 'atras':
          await mano(() => manos.back())();
          hecho = 'Gesto de volver hecho.';
          break;
        case 'desplazar':
          await desplazar(m, args.direccion === 'arriba' ? 'arriba' : 'abajo', args.cantidad ?? 1);
          hecho = `Desplazado hacia ${args.direccion === 'arriba' ? 'arriba' : 'abajo'}.`;
          break;
        case 'abrir_app': {
          const nombre = await abrirApp(m, ojos, args.app ?? '', sleep);
          hecho = `Buscado «${nombre}» y pulsado Intro (Inicio, buscar, Intro): comprueba en la pantalla de despues que se ha abierto esa app.`;
          break;
        }
        default:
          throw new Error('action desconocida.');
      }
    } catch (err) {
      if (err instanceof BloqueadoError) {
        return {
          content: [text(err.message)],
          details: { entrega: enviando ? 'parcial' : 'no-enviado', bloqueado: true },
        };
      }
      if (!enviando) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          text(
            `Sin saber si se ha hecho del todo: ${msg} Mira la pantalla (action=texto) antes de repetirlo.`,
          ),
        ],
        details: { entrega: 'desconocido' },
      };
    }
    log.info('iphone paso', { action: args.action });
    let despues = 'Mira el resultado con action=texto o action=screenshot.';
    let quieta: { cambio: boolean | null; quieta: boolean; ms: number } | null = null;
    const ocr = deps.ocr;
    if (!ocr) {
      await sleep(PAUSA_TRAS_PASO_MS);
    } else {
      try {
        // En vez de una pausa fija: esperar a que la pantalla cambie y se quede quieta.
        const r = await esperarQuieta({
          leer: async () => lineasDePantalla(await ocr(await deps.frame())),
          firma: firmaLineas,
          antes: firmaPrevia,
          espera: sleep,
        });
        quieta = { cambio: r.cambio, quieta: r.quieta, ms: r.ms };
        const nota =
          r.cambio === false
            ? 'La pantalla NO ha cambiado tras el paso: puede que no haya hecho efecto (mira antes de repetirlo). '
            : !r.quieta
              ? 'La pantalla seguia moviendose al leerla: puede faltar algo por cargar. '
              : '';
        despues = `${nota}Pantalla despues:\n${formatearPantalla(r.lectura)}`;
      } catch {
        despues =
          'No he podido leer la pantalla despues: mira con action=texto o action=screenshot.';
      }
    }
    return {
      content: [text(`${hecho} ${despues}`)],
      details: { entrega: 'hecho', verified: false, ...(quieta ? { pantalla: quieta } : {}) },
    };
  }

  return {
    name: 'iphone',
    label: 'iPhone',
    description: [
      ble
        ? 'Maneja el iPhone real de Nico desde este PC: toca y escribe por Bluetooth (el PC hace de teclado y puntero) y ve su pantalla por AirPlay (UxPlay). No hay agente del telefono: action=run no existe en este modo, usa los pasos sueltos.'
        : 'Maneja el iPhone real de Nico a traves de una ESP32 (raton USB) y su pantalla por AirPlay.',
      'action=status dice si el puente esta listo (ESP32 conectada, pantalla en directo, puntero calibrado)',
      'y si hay una tarea en marcha. Mira SIEMPRE el status antes de lanzar nada.',
      'action=setup es el alta guiada: lista los pasos para dejar el telefono listo, marca los hechos y dice el siguiente.',
      'Usala cuando Nico quiera conectarlo o status diga que no esta listo. Es de solo lectura.',
      'action=screenshot devuelve la pantalla del telefono ahora mismo.',
      'action=texto devuelve esa misma pantalla como lineas de texto con su posicion (x y en fracciones, 0 a 1):',
      'gasta mucho menos que una captura; usala primero y pide screenshot solo para fotos o iconos sin texto.',
      'action=run con goal le da una tarea al agente del telefono y espera (waitSeconds) a que acabe;',
      'devuelve cuantos pasos dio y la pantalla final. Es un agente aparte con su propio modelo:',
      'puede equivocarse o no terminar. Comprueba el resultado con la captura final, no con su palabra.',
      'action=stop es la parada de emergencia, action=home vuelve a la pantalla de inicio.',
      'Limites: solo ve pixeles (no lee notificaciones ni el estado interno); si el telefono se bloquea o',
      'se corta el AirPlay, la tarea se queda parada. Nunca introduzcas contrasenas ni codigos por aqui',
      'salvo que Nico lo pida en esta conversacion.',
      ...(deps.gestos
        ? [
            'Pasos sueltos (cada uno pide permiso a Nico): tocar (x, y en fracciones), tocar_texto (texto que se ve, p. ej. «Wi-Fi»),',
            'escribir (texto ASCII, sin tildes ni enes; \\n = Intro), tecla (combo), atras, desplazar (direccion, cantidad) y abrir_app (app).',
            'Cada paso devuelve la pantalla despues en texto. Bucle: texto, decide, un paso, mira el resultado.',
            'No escriben ni tocan con el telefono bloqueado, ni tocan la isla dinamica (arriba en el centro: corta la duplicacion).',
          ]
        : []),
    ].join(' '),
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'status': {
          const s = await deps.status();
          const missing = faltan(s);
          const lines = [
            missing.length
              ? `NO listo: ${missing.join('; ')}.`
              : ble
                ? 'Listo: iPhone conectado por Bluetooth a este PC (puntero absoluto, sin calibrar) y pantalla de UxPlay en directo.'
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
        case 'setup': {
          let status: IphoneStatus | null = null;
          let problem: string | undefined;
          try {
            status = await deps.status();
          } catch (err) {
            problem = err instanceof Error ? err.message : String(err);
          }
          const guide = guia(status, problem);
          const lines = guide.steps.map(
            (s, i) => `${i + 1}. [${s.done ? 'hecho' : 'falta'}] ${s.text}`,
          );
          const head = guide.next
            ? `Alta del iPhone: faltan pasos. Siguiente: ${guide.next}`
            : 'Alta del iPhone completa: todo listo.';
          return {
            content: [text([head, ...lines].join('\n'))],
            details: { ready: guide.next === null, steps: guide.steps },
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
        case 'texto': {
          if (!deps.ocr) {
            throw new Error(
              'No puedo leer la pantalla en texto aqui (hace falta el OCR de Windows). Usa action=screenshot.',
            );
          }
          const jpeg = await deps.frame();
          const ocr = await deps.ocr(jpeg);
          const lineas = lineasDePantalla(ocr, { todo: args.todo === true });
          const bloqueado = pantallaBloqueada(lineasDePantalla(ocr, { todo: true }));
          const aviso = bloqueado
            ? 'AVISO: el iPhone esta BLOQUEADO (pantalla de bloqueo o de codigo). No escribas ni toques nada: pide a Nico que lo desbloquee el.\n'
            : '';
          return {
            content: [text(aviso + formatearPantalla(lineas))],
            details: { lineas: lineas.length, bloqueado },
          };
        }
        case 'tocar':
        case 'tocar_texto':
        case 'escribir':
        case 'tecla':
        case 'atras':
        case 'desplazar':
        case 'abrir_app':
          return enqueue(() => paso(args));
        case 'run': {
          const goal = (args.goal ?? '').trim();
          if (!goal)
            throw new Error('action=run necesita goal: una tarea concreta para el telefono.');
          const waitS = Math.min(Math.max(args.waitSeconds ?? DEFAULT_WAIT_S, 0), MAX_WAIT_S);
          return enqueue(async () => {
            const before = await deps.status();
            const missing = faltan(before);
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
          // FUERA de la cola: un run puede estar esperando hasta 600 s y la
          // parada de emergencia no puede quedar detras de el.
          await deps.stop();
          return { content: [text('Parada de emergencia enviada al telefono.')], details: {} };
        }
        case 'home': {
          // Tambien fuera de la cola (no debe esperar a un run), pero no se
          // pulsa Inicio por debajo de una tarea en marcha: eso la rompe.
          const s = await deps.status();
          if (s.agent.running) {
            throw new Error(
              `Hay una tarea en marcha ("${s.agent.task ?? ''}"). Usa action=stop primero si quieres cortarla.`,
            );
          }
          await deps.home();
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

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Config } from '../config.js';
import { log } from '../log.js';
import { compareFrames, type FrameDiff } from '../screen/verify.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Desktop control: screenshot, click, move, drag, type, key.
 *
 * Findings that shaped this file:
 *
 * - Screenshots dominate the token bill: ~1.5k tokens at 1280x800, ~2.85k at
 *   1920x1080. The default max edge is 1280 because a fare table still reads at
 *   that size and it roughly halves the cost versus full resolution.
 * - `space-bunny-free` leaks tool calls into `content` roughly a quarter of the
 *   time, tagged `<|minimax|>...<|tool_call|>`. The harness only reads the
 *   tool_calls channel, so those steps would silently vanish. `normalizeAction()`
 *   below is the recovery path for when that happens.
 * - This model returns absolute pixels. Several open computer-use models
 *   (UI-TARS-1.5, Holo) return coordinates normalised to [0,1000] instead, so if
 *   you swap the provider, that is the line to change.
 */
export type Action =
  | { action: 'screenshot' }
  | { action: 'click'; x: number; y: number; button?: string; clicks?: number }
  | { action: 'move'; x: number; y: number }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number }
  | { action: 'type'; text: string }
  | { action: 'key'; key: string };

export interface ScreenShot {
  image: Buffer;
  mimeType: string;
  /** Size of the image handed to the model. All coordinates live in this space. */
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
}

export interface ScreenBackend {
  screenshot(): Promise<ScreenShot>;
  click(x: number, y: number, opts?: { button?: string; clicks?: number }): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(x: number, y: number, toX: number, toY: number): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  screenSize(): Promise<{ width: number; height: number }>;
}

/**
 * Recover an action from text the model emitted outside the tool_calls channel.
 * Returns null when nothing parses, so the caller can re-ask rather than act on a
 * guess.
 */
export function normalizeAction(text: string): Action | null {
  const tagged = /<\|tool_call\|>\s*([\s\S]*?)\s*<\/?tool_call>/.exec(text);
  const blob = tagged?.[1] ?? text;
  const start = blob.indexOf('{');
  const end = blob.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(blob.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const wrapper = parsed as Record<string, unknown>;
  // The leaked form nests the payload one level down:
  //   {"name":"computer","arguments":{"action":"click","x":113,"y":175}}
  const o = (
    typeof wrapper.arguments === 'object' && wrapper.arguments !== null
      ? wrapper.arguments
      : wrapper
  ) as Record<string, unknown>;
  const name =
    typeof o.action === 'string' ? o.action : typeof o.type === 'string' ? o.type : undefined;
  switch (name) {
    case 'screenshot':
      return { action: 'screenshot' };
    case 'click':
      return {
        action: 'click',
        x: Number(o.x),
        y: Number(o.y),
        button: String(o.button ?? 'left'),
        clicks: Number(o.clicks ?? 1),
      };
    case 'move':
      return { action: 'move', x: Number(o.x), y: Number(o.y) };
    case 'drag':
      return {
        action: 'drag',
        x: Number(o.x),
        y: Number(o.y),
        toX: Number(o.toX),
        toY: Number(o.toY),
      };
    case 'type':
      return { action: 'type', text: String(o.text ?? '') };
    case 'key':
      return { action: 'key', key: String(o.key ?? '') };
    default:
      return null;
  }
}

const ComputerParams = Type.Object({
  action: Type.Union([
    Type.Literal('screenshot'),
    Type.Literal('click'),
    Type.Literal('move'),
    Type.Literal('drag'),
    Type.Literal('type'),
    Type.Literal('key'),
  ]),
  x: Type.Optional(Type.Number({ description: 'X coordinate in real screen pixels.' })),
  y: Type.Optional(Type.Number({ description: 'Y coordinate in real screen pixels.' })),
  toX: Type.Optional(Type.Number()),
  toY: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String({ description: 'Text for the type action.' })),
  key: Type.Optional(
    Type.String({
      description:
        'Chord for the key action, e.g. "enter", "ctrl+s", "alt+F4", "shift+tab". Not SendKeys syntax.',
    }),
  ),
  button: Type.Optional(Type.String()),
  clicks: Type.Optional(Type.Number()),
});

interface Screen {
  width: number;
  height: number;
}

/**
 * Clamp and reject out-of-bounds coordinates, then translate them into real screen
 * pixels. A model that hallucinates 99999,99999 would otherwise send the cursor
 * somewhere arbitrary; a clear error is recoverable, a stray click is not.
 *
 * Bounds are checked twice, on purpose: once in the space the model was working in
 * (so a wrong click is caught before it becomes a real event) and once in real
 * pixels (so rounding after scaling cannot push it off the edge).
 */
function coords(
  args: Record<string, unknown>,
  view: Screen,
  native: Screen,
): { x: number; y: number } {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('this action requires numeric x and y');
  }
  if (x < 0 || y < 0 || x >= view.width || y >= view.height) {
    throw new Error(
      `coordinates ${x},${y} fall outside the ${view.width}x${view.height} image you were shown`,
    );
  }
  const real = toRealCoordinates(x, y, view, native);
  if (real.x < 0 || real.y < 0 || real.x >= native.width || real.y >= native.height) {
    throw new Error(
      `coordinates ${real.x},${real.y} fall outside the ${native.width}x${native.height} screen`,
    );
  }
  return real;
}

/**
 * Convert coordinates the model read off a screenshot into real desktop pixels.
 *
 * This exists because screenshots are downscaled to bound token cost, and a model
 * that clicks at (440,347) on a 1280x720 image must land at (660,520) on a 1920x1080
 * desktop. Handing the raw scaled number to SetCursorPos put the click in the wrong
 * place — which looked like the model being careless and cost entire retries.
 *
 * The two alternative designs were both worse:
 *
 * - Tell the model the scale factor and let it multiply: it gets it subtly wrong,
 *   and a wrong multiplier is indistinguishable from a wrong target.
 * - Keep full-resolution screenshots: correct, and ~2x the image tokens on every
 *   step of every task. Cost bought reliability at a 4k-token/step premium.
 *
 * So the model always speaks in "screenshot pixels" and the tool translates. When no
 * screenshot has been taken yet the factor is 1, which is the honest answer.
 */
export function toRealCoordinates(
  x: number,
  y: number,
  view: { width: number; height: number },
  native: { width: number; height: number },
): { x: number; y: number } {
  if (view.width <= 0 || view.height <= 0) return { x, y };
  return {
    x: Math.round((x * native.width) / view.width),
    y: Math.round((y * native.height) / view.height),
  };
}

/**
 * `config` carries screenshot scaling and quality policy so that policy lives in
 * one place. The backend is told about it here, which is also what makes the
 * coordinate translation above possible.
 */
export function createComputerTool(
  config: Config,
  backend: ScreenBackend,
): AgentTool<typeof ComputerParams> {
  const scaling = { maxEdge: config.screenshotMaxEdge, quality: config.screenshotQuality };
  const rescalable = backend as ScreenBackend & {
    setScaling?: (maxEdge: number, quality: number) => void;
  };
  rescalable.setScaling?.(config.screenshotMaxEdge, config.screenshotQuality);

  // Size of the last image shown to the model. Until one exists, coordinates are
  // assumed to be real pixels.
  let view: { width: number; height: number } | null = null;

  /**
   * Verify that an action changed something, by diffing the screen before and after.
   *
   * This is the highest-value thing in the file for a model with mediocre grounding.
   * The dominant failure in GUI work is not a bad decision, it is a click that did
   * nothing followed by the same click again, because the agent had no way to tell
   * the two apart. This returns a fact rather than an opinion and costs no tokens.
   *
   * The price is two extra screenshots per action, which on Windows is a PowerShell
   * round trip each and roughly doubles the latency of a click. That is a deliberate
   * trade against the retry loop it removes; `PA_VERIFY_ACTIONS=0` turns it off for
   * setups where the latency hurts more than the repeats did.
   */
  const verify = async (
    action: () => Promise<void>,
    at?: { x: number; y: number },
  ): Promise<FrameDiff | null> => {
    if (!config.verifyActions) return null;
    let before: Buffer;
    try {
      // Captured at the downscaled size on purpose: this frame is never shown to the
      // model, and comparing two frames of the same small geometry keeps the
      // thresholds in one coordinate space. Diffing the model's downscaled image would
      // inject resampler noise into every comparison, which is exactly the noise a
      // perceptual diff exists to reject.
      before = (await backend.screenshot()).image;
    } catch (err) {
      log.warn('verification baseline capture failed', { err });
      return null;
    }
    await action();
    // Long enough for a repaint to land. Windows animations run 150-250ms, so a
    // shorter settle reports the change before it is visible.
    await sleep(config.verifySettleMs);
    let after: Buffer;
    try {
      after = (await backend.screenshot()).image;
    } catch (err) {
      log.warn('verification post-action capture failed', { err });
      return null;
    }
    return compareFrames(before, after, at ? { at, radius: 48 } : {});
  };

  return {
    name: 'computer',
    label: 'Computer',
    description: [
      'Control the desktop. Actions: screenshot (returns the screen as an image),',
      'click (x, y), move (x, y), drag (x,y to toX,toY), type (text), key (chord).',
      'Coordinates are pixels in the screenshot you were shown, origin top-left.',
      'For key, use chords like "enter", "ctrl+s", "alt+F4", "shift+tab" — not symbols.',
      'Always screenshot first; never guess coordinates.',
      'Every click, drag, type and keypress returns a VERIFICACION line saying whether',
      'the screen really changed. If it says it did not, do not repeat the action: take',
      'a fresh screenshot and locate the element again, because the coordinates were',
      'wrong.',
    ].join(' '),
    parameters: ComputerParams,
    // Sequential on purpose: two input actions in one batch can interleave and fight
    // over the mouse, which produces a click on the wrong thing and is very hard to
    // diagnose afterwards.
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const record = args as unknown as Record<string, unknown>;

      switch (args.action) {
        case 'screenshot': {
          const shot = await backend.screenshot();
          view = { width: shot.width, height: shot.height };
          const downscaled = shot.width !== shot.nativeWidth || shot.height !== shot.nativeHeight;
          log.debug('screenshot', { bytes: shot.image.length, ...shot, image: undefined });
          return {
            content: [
              {
                type: 'text',
                text:
                  `Screenshot ${shot.width}x${shot.height}. Origin top-left.` +
                  (downscaled ? ` Real desktop is ${shot.nativeWidth}x${shot.nativeHeight}.` : ''),
              },
              { type: 'image', mimeType: shot.mimeType, data: shot.image.toString('base64') },
            ],
            details: {
              width: shot.width,
              height: shot.height,
              nativeWidth: shot.nativeWidth,
              nativeHeight: shot.nativeHeight,
              ...scaling,
            },
          };
        }

        case 'click': {
          const native = await backend.screenSize();
          const p = coords(record, view ?? native, native);
          // The comparison frames are at the downscaled geometry, so the action point
          // is scaled down with them rather than handed over in native pixels.
          const roi = view
            ? {
                x: Math.round((p.x * view.width) / native.width),
                y: Math.round((p.y * view.height) / native.height),
              }
            : { x: p.x, y: p.y };
          const check = await verify(
            () =>
              backend.click(p.x, p.y, {
                button: String(record.button ?? 'left'),
                clicks: Number(record.clicks ?? 1),
              }),
            roi,
          );
          log.info('click', { ...p, changed: check?.changed ?? null });
          return {
            content: [
              { type: 'text', text: `Clicked ${p.x},${p.y}${check ? `\n${check.verdict}` : ''}` },
            ],
            details: {
              ...p,
              verified: check?.changed ?? null,
              localRatio: check?.localRatio ?? null,
            },
          };
        }

        case 'move': {
          const native = await backend.screenSize();
          const p = coords(record, view ?? native, native);
          // A move is an observation, not an action. Verifying it would cost two
          // screenshots to learn that a hover sometimes does nothing, which is both
          // true and useless.
          await backend.move(p.x, p.y);
          return { content: [{ type: 'text', text: `Moved to ${p.x},${p.y}` }], details: p };
        }

        case 'drag': {
          const native = await backend.screenSize();
          const from = coords(record, view ?? native, native);
          const to = coords({ x: record.toX, y: record.toY }, view ?? native, native);
          const check = await verify(() => backend.drag(from.x, from.y, to.x, to.y));
          return {
            content: [
              {
                type: 'text',
                text: `Dragged ${from.x},${from.y} to ${to.x},${to.y}${check ? `\n${check.verdict}` : ''}`,
              },
            ],
            details: { from, to, verified: check?.changed ?? null },
          };
        }

        case 'type': {
          const text = String(record.text ?? '');
          if (!text) throw new Error('the type action requires text');
          const check = await verify(() => backend.type(text));
          log.info('typed', { chars: text.length, changed: check?.changed ?? null });
          return {
            content: [
              {
                type: 'text',
                text: `Typed ${text.length} characters${check ? `\n${check.verdict}` : ''}`,
              },
            ],
            details: { chars: text.length, verified: check?.changed ?? null },
          };
        }

        case 'key': {
          const key = String(record.key ?? '');
          if (!key) throw new Error('the key action requires a key name');
          const check = await verify(() => backend.key(key));
          return {
            content: [{ type: 'text', text: `Pressed ${key}${check ? `\n${check.verdict}` : ''}` }],
            details: { key, verified: check?.changed ?? null },
          };
        }

        default:
          throw new Error(`unknown action: ${String(args.action)}`);
      }
    },
  };
}

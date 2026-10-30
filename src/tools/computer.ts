import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Config } from '../config.js';
import { log } from '../log.js';
import type { Decision, ToolCall } from '../permissions.js';
import { expand, type Region, scaleRegion } from '../screen/regions.js';
import {
  type BatchVerdict,
  captureRoi,
  compareFrames,
  type FrameDiff,
  notCompared,
  type Screenshot,
  verifyBatch,
} from '../screen/verify.js';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `verified` in details: true/false only when a comparison really ran. */
function verifiedOf(check: FrameDiff | null): boolean | null {
  return check && !check.failed ? check.changed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Desktop control: screenshot, click, move, drag, type, key, batch.
 *
 * Findings that shaped this file:
 *
 * - Screenshots dominate the token bill: ~1.5k tokens at 1280x800, ~2.85k at
 *   1920x1080. The default max edge is 1280 because a fare table still reads at
 *   that size and it roughly halves the cost versus full resolution.
 * - Every action is a model round trip, and a task of twenty clicks pays twenty
 *   of them even when the plan was decided in one breath. `batch` runs a list of
 *   actions inside ONE tool call so the round trips collapse to one; an optional
 *   `roi` on screenshot/click shrinks the image and the coordinate space to the
 *   part of the screen the task is actually about.
 * - `space-bunny-free` leaks tool calls into `content` roughly a quarter of the
 *   time, tagged `<|minimax|>...<|tool_call|>`. The harness only reads the
 *   tool_calls channel, so those steps would silently vanish. `normalizeAction()`
 *   below is the recovery path for when that happens.
 * - This model returns absolute pixels. Several open computer-use models
 *   (UI-TARS-1.5, Holo) return coordinates normalised to [0,1000] instead, so if
 *   you swap the provider, that is the line to change.
 */
export type Action =
  | { action: 'screenshot'; roi?: Region }
  | { action: 'click'; x: number; y: number; button?: string; clicks?: number; roi?: Region }
  | { action: 'move'; x: number; y: number }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number }
  | { action: 'type'; text: string; secret?: boolean }
  | { action: 'key'; key: string }
  | { action: 'batch'; actions: Array<Record<string, unknown>> };

/**
 * The permission check one action must pass before it runs: literally
 * `Gate.check` from permissions.ts with the session and actor bound by the
 * wiring, `(call) => gate.check(sessionId, { ...call, actor })`.
 *
 * A standalone action already passes through this gate in `beforeToolCall`
 * (core/agent.ts). A batch's sub-actions never reach that hook — they are
 * arguments inside one tool call — so the batch runs each one through this same
 * check instead of letting the approval of the outer `batch` cover them all.
 * When nothing is wired the batch fails closed: nothing runs, and the report says
 * so in one clear line rather than silently blocking on the first action.
 */
export type ActionGate = (call: ToolCall) => Decision | Promise<Decision>;

/**
 * Why a batch ran nothing when the tool was built without a gate. One constant so
 * the summary line and the per-item errors can never disagree about the reason.
 */
const NO_GATE_REASON = 'el lote no puede ejecutarse: falta el control de permisos';

/** Fate of one action inside a `batch`, in the order they were requested. */
export interface BatchItemResult {
  index: number;
  action: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

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
      return {
        action: 'type',
        text: String(o.text ?? ''),
        ...(o.secret === true ? { secret: true } : {}),
      };
    case 'key':
      return { action: 'key', key: String(o.key ?? '') };
    default:
      return null;
  }
}

const RegionParams = Type.Object(
  {
    x: Type.Number({ description: 'Left edge in screenshot pixels.' }),
    y: Type.Number({ description: 'Top edge in screenshot pixels.' }),
    width: Type.Number({ description: 'Width in screenshot pixels.' }),
    height: Type.Number({ description: 'Height in screenshot pixels.' }),
  },
  {
    description:
      'Region of interest in screenshot pixels. With screenshot, only that region is captured. ' +
      'With click, x/y are relative to the roi top-left.',
  },
);

const ComputerParams = Type.Object({
  action: Type.Union([
    Type.Literal('screenshot'),
    Type.Literal('click'),
    Type.Literal('move'),
    Type.Literal('drag'),
    Type.Literal('type'),
    Type.Literal('key'),
    Type.Literal('batch'),
  ]),
  x: Type.Optional(Type.Number({ description: 'X coordinate in real screen pixels.' })),
  y: Type.Optional(Type.Number({ description: 'Y coordinate in real screen pixels.' })),
  toX: Type.Optional(Type.Number()),
  toY: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String({ description: 'Text for the type action.' })),
  secret: Type.Optional(
    Type.Boolean({
      description:
        'For type: mark the text as a secret (credential or token). A secret type is ' +
        'never approved through a chat question - the approval is denied and the vault ' +
        'flow must type it instead. Never ask the user to paste the secret.',
    }),
  ),
  key: Type.Optional(
    Type.String({
      description:
        'Chord for the key action, e.g. "enter", "ctrl+s", "alt+F4", "shift+tab". Not SendKeys syntax.',
    }),
  ),
  button: Type.Optional(Type.String()),
  clicks: Type.Optional(Type.Number()),
  roi: Type.Optional(RegionParams),
  send: Type.Optional(
    Type.Boolean({
      description:
        'For screenshot: also push the image to the user chat. Use it whenever they ' +
        'asked for a capture, so the picture arrives in the chat and not only in your ' +
        'context.',
    }),
  ),
  actions: Type.Optional(
    Type.Array(Type.Record(Type.String(), Type.Unknown()), {
      description: 'For the batch action: the actions to run in order, each like a single action.',
    }),
  ),
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
 * Read an optional `roi` argument. Throws on a present-but-malformed roi rather
 * than ignoring it: the model asked to restrict an action to a region, and
 * silently performing it on the whole screen is worse than a clear error.
 */
function parseRegionField(value: unknown, label: string): Region | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object with x, y, width and height`);
  }
  const r = value as Record<string, unknown>;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new Error(`${label} must have finite x, y, width and height`);
  }
  if (width < 0 || height < 0) {
    throw new Error(`${label} cannot have negative width or height`);
  }
  return { x, y, width, height };
}

/**
 * `coords()` for ROI-relative input. Same double check, same recovery philosophy:
 * first against the box the coordinates are relative to (so a wrong click is
 * caught before it becomes a real event), then in real pixels (so rounding after
 * scaling cannot push it off the edge). The translation itself is `scaleRegion`,
 * the region-native form of `toRealCoordinates`.
 */
function coordsInRoi(
  args: Record<string, unknown>,
  roi: Region,
  view: Screen,
  native: Screen,
): { x: number; y: number; viewX: number; viewY: number } {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('this action requires numeric x and y');
  }
  if (x < 0 || y < 0 || x >= roi.width || y >= roi.height) {
    throw new Error(
      `coordinates ${x},${y} fall outside the roi ${roi.width}x${roi.height} they are relative to`,
    );
  }
  // Offsetting by the roi lands the point in the full screenshot space first —
  // the space `view` measures — and one scaleRegion then performs exactly the
  // screenshot-to-desktop translation `toRealCoordinates` performs for absolute
  // clicks.
  const viewX = roi.x + x;
  const viewY = roi.y + y;
  const scaled = scaleRegion(
    { x: viewX, y: viewY, width: 0, height: 0 },
    { x: 0, y: 0, width: view.width, height: view.height },
    { x: 0, y: 0, width: native.width, height: native.height },
  );
  if (scaled.x < 0 || scaled.y < 0 || scaled.x >= native.width || scaled.y >= native.height) {
    throw new Error(
      `coordinates ${scaled.x},${scaled.y} fall outside the ${native.width}x${native.height} screen`,
    );
  }
  return { x: scaled.x, y: scaled.y, viewX, viewY };
}

/**
 * The mouse button for a click: left, right or middle, case-insensitive. An
 * unknown name is refused here, before any input event: the backend used to turn
 * it into a left-down with no matching left-up, leaving the button held.
 */
function parseButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === undefined || value === null || value === '') return 'left';
  const name = String(value).trim().toLowerCase();
  if (name === 'left' || name === 'right' || name === 'middle') return name;
  throw new Error(`unknown mouse button "${String(value)}": use left, right or middle`);
}

/** Click count: a whole number 1-5 (the backend's own range); anything else is refused. */
function parseClicks(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new Error(`clicks must be a whole number from 1 to 5, got ${String(value)}`);
  }
  return n;
}

/** Actions that change the screen, and therefore deserve before/after verification. */
function isMutatingAction(name: string): boolean {
  return name === 'click' || name === 'drag' || name === 'type' || name === 'key';
}

/** Narrow `batch.actions` to a list of action records, or null when the shape is wrong. */
function asActionList(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    out.push(item as Record<string, unknown>);
  }
  return out;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

interface ActionOutcome {
  content: ContentBlock[];
  details: Record<string, unknown>;
  /**
   * Where a click was expected to land, in screenshot pixels. Feeds the batch's
   * verification pair (a 96x96 window around the point, matching the radius a
   * standalone click verifies with).
   */
  at: { x: number; y: number } | null;
}

/**
 * `config` carries screenshot scaling and quality policy so that policy lives in
 * one place. The backend is told about it here, which is also what makes the
 * coordinate translation above possible.
 *
 * `gate` is the permission check for `batch` sub-actions (see `ActionGate`).
 * Single actions do not re-check here: they already passed `Gate.check` in
 * `beforeToolCall`, and asking twice would prompt the human twice.
 */
export function createComputerTool(
  config: Config,
  backend: ScreenBackend,
  gate?: ActionGate,
  sendPhoto?: (bytes: Buffer, opts: { width: number; height: number }) => Promise<boolean>,
): AgentTool<typeof ComputerParams> {
  const scaling = { maxEdge: config.screenshotMaxEdge, quality: config.screenshotQuality };
  const rescalable = backend as ScreenBackend & {
    setScaling?: (maxEdge: number, quality: number) => void;
  };
  rescalable.setScaling?.(config.screenshotMaxEdge, config.screenshotQuality);

  // Size of the full-frame capture the model's coordinates live in. Until one
  // exists, coordinates are assumed to be real pixels. ROI crops deliberately do
  // NOT change it: a crop keeps the capture's scale, so the model's roi-relative
  // coordinates share this space already (see `captureRoi`).
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
    if (!config.verifyActions) {
      // The diff is what is optional, not the action: `PA_VERIFY_ACTIONS=0` buys
      // back the two captures per action, it must not disable clicking.
      await action();
      return null;
    }
    let before: Buffer;
    try {
      // Captured at the downscaled size on purpose: this frame is never shown to the
      // model, and comparing two frames of the same small geometry keeps the
      // thresholds in one coordinate space. Diffing the model's downscaled image would
      // inject resampler noise into every comparison, which is exactly the noise a
      // perceptual diff exists to reject.
      before = (await backend.screenshot()).image;
    } catch (err) {
      // The capture is what failed, not the action: run it anyway. Returning here
      // without acting reported "Clicked"/"Pressed" for an action that never
      // happened, and the model carried on as if it had.
      log.warn('verification baseline capture failed', { err });
      await action();
      return notCompared(`la captura previa ha fallado (${errorText(err)})`);
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
      return notCompared(`la captura posterior ha fallado (${errorText(err)})`);
    }
    return compareFrames(before, after, at ? { at, radius: 48 } : {});
  };

  /**
   * Run exactly one action. This is the single code path for both a standalone
   * call and a batch item: the batch reuses it so no check (`coords`, text
   * required, key required, …) can be skipped by going through `batch`.
   *
   * `verifyResult: false` defers post-action verification to the batch's single
   * final pass — that is the whole point of batching, since a verify per action
   * is two extra captures and a settle per action.
   */
  const runAction = async (
    record: Record<string, unknown>,
    opts: { verifyResult: boolean },
  ): Promise<ActionOutcome> => {
    /**
     * Run one input action, wrapped in verification only when this action owns
     * the verdict. The action ALWAYS runs: a batch item defers the diff to the
     * batch's final pass, it does not defer the click itself.
     */
    const act = async (
      action: () => Promise<void>,
      at?: { x: number; y: number },
    ): Promise<FrameDiff | null> => {
      if (!opts.verifyResult) {
        await action();
        return null;
      }
      return verify(action, at);
    };

    switch (record.action) {
      case 'screenshot': {
        const roi = parseRegionField(record.roi, 'roi');
        if (roi) {
          const cropped = await captureRoi(backend, roi);
          // The picture has to reach the chat, not just this context: the user asked
          // for it, and an image they cannot see is an image nobody sent.
          const sent = record.send
            ? await sendPhoto?.(cropped.image, { width: cropped.width, height: cropped.height })
            : undefined;
          if (!view) {
            // No full frame yet: reconstruct the capture scale from the crop's
            // own ratio so later clicks translate correctly even when the very
            // first thing the model asked for was a region.
            const native = await backend.screenSize();
            const scale = cropped.nativeWidth > 0 ? cropped.width / cropped.nativeWidth : 1;
            view = {
              width: Math.max(1, Math.round(native.width * scale)),
              height: Math.max(1, Math.round(native.height * scale)),
            };
          }
          log.debug('screenshot roi', {
            ...cropped,
            image: undefined,
            roi,
            croppedOk: !cropped.detail,
          });
          return {
            content: [
              {
                type: 'text',
                text:
                  `Screenshot ${cropped.width}x${cropped.height} of roi (${roi.x},${roi.y} ` +
                  `${roi.width}x${roi.height}). Origin top-left of the roi.` +
                  (cropped.detail ? ` ${cropped.detail}.` : '') +
                  (sent === undefined
                    ? ''
                    : sent
                      ? ' Enviada al chat.'
                      : ' No he podido enviarla al chat.'),
              },
              {
                type: 'image',
                mimeType: cropped.mimeType,
                data: cropped.image.toString('base64'),
              },
            ],
            details: {
              width: cropped.width,
              height: cropped.height,
              nativeWidth: cropped.nativeWidth,
              nativeHeight: cropped.nativeHeight,
              roi,
              cropped: !cropped.detail,
              sent,
              ...scaling,
            },
            at: null,
          };
        }
        const shot: Screenshot = await backend.screenshot();
        view = { width: shot.width, height: shot.height };
        const downscaled = shot.width !== shot.nativeWidth || shot.height !== shot.nativeHeight;
        log.debug('screenshot', { bytes: shot.image.length, ...shot, image: undefined });
        const sent = record.send
          ? await sendPhoto?.(shot.image, { width: shot.width, height: shot.height })
          : undefined;
        return {
          content: [
            {
              type: 'text',
              text:
                `Screenshot ${shot.width}x${shot.height}. Origin top-left.` +
                (downscaled ? ` Real desktop is ${shot.nativeWidth}x${shot.nativeHeight}.` : '') +
                (sent === undefined
                  ? ''
                  : sent
                    ? ' Enviada al chat.'
                    : ' No he podido enviarla al chat.'),
            },
            { type: 'image', mimeType: shot.mimeType, data: shot.image.toString('base64') },
          ],
          details: {
            width: shot.width,
            height: shot.height,
            nativeWidth: shot.nativeWidth,
            nativeHeight: shot.nativeHeight,
            sent,
            ...scaling,
          },
          at: null,
        };
      }

      case 'click': {
        const native = await backend.screenSize();
        const roi = parseRegionField(record.roi, 'roi');
        const button = parseButton(record.button);
        const clicks = parseClicks(record.clicks);
        if (roi) {
          const p = coordsInRoi(record, roi, view ?? native, native);
          // Verification looks at the point in screenshot space, same as the
          // standalone path below: the comparison frames are captured at that
          // geometry.
          const at = { x: p.viewX, y: p.viewY };
          const check = await act(() => backend.click(p.x, p.y, { button, clicks }), at);
          log.info('click roi', { ...p, changed: check?.changed ?? null });
          return {
            content: [
              {
                type: 'text',
                text: `Clicked ${p.x},${p.y} (roi-relative ${Number(record.x)},${Number(record.y)})${
                  check ? `\n${check.verdict}` : ''
                }`,
              },
            ],
            details: {
              x: p.x,
              y: p.y,
              viewX: p.viewX,
              viewY: p.viewY,
              roi,
              verified: verifiedOf(check),
              localRatio: check?.localRatio ?? null,
            },
            at,
          };
        }
        const p = coords(record, view ?? native, native);
        // The comparison frames are at the downscaled geometry, so the action point
        // is scaled down with them rather than handed over in native pixels.
        const at = view
          ? {
              x: Math.round((p.x * view.width) / native.width),
              y: Math.round((p.y * view.height) / native.height),
            }
          : { x: p.x, y: p.y };
        const check = await act(
          () =>
            backend.click(p.x, p.y, {
              button,
              clicks,
            }),
          at,
        );
        log.info('click', { ...p, changed: check?.changed ?? null });
        return {
          content: [
            { type: 'text', text: `Clicked ${p.x},${p.y}${check ? `\n${check.verdict}` : ''}` },
          ],
          details: {
            ...p,
            verified: verifiedOf(check),
            localRatio: check?.localRatio ?? null,
          },
          at,
        };
      }

      case 'move': {
        const native = await backend.screenSize();
        const p = coords(record, view ?? native, native);
        // A move is an observation, not an action. Verifying it would cost two
        // screenshots to learn that a hover sometimes does nothing, which is both
        // true and useless.
        await backend.move(p.x, p.y);
        return {
          content: [{ type: 'text', text: `Moved to ${p.x},${p.y}` }],
          details: p,
          at: null,
        };
      }

      case 'drag': {
        const native = await backend.screenSize();
        const from = coords(record, view ?? native, native);
        const to = coords({ x: record.toX, y: record.toY }, view ?? native, native);
        const check = await act(() => backend.drag(from.x, from.y, to.x, to.y));
        return {
          content: [
            {
              type: 'text',
              text: `Dragged ${from.x},${from.y} to ${to.x},${to.y}${
                check ? `\n${check.verdict}` : ''
              }`,
            },
          ],
          details: { from, to, verified: verifiedOf(check) },
          at: null,
        };
      }

      case 'type': {
        const text = String(record.text ?? '');
        if (!text) throw new Error('the type action requires text');
        const check = await act(() => backend.type(text));
        log.info('typed', { chars: text.length, changed: check?.changed ?? null });
        return {
          content: [
            {
              type: 'text',
              text: `Typed ${text.length} characters${check ? `\n${check.verdict}` : ''}`,
            },
          ],
          details: { chars: text.length, verified: verifiedOf(check) },
          at: null,
        };
      }

      case 'key': {
        const key = String(record.key ?? '');
        if (!key) throw new Error('the key action requires a key name');
        const check = await act(() => backend.key(key));
        return {
          content: [{ type: 'text', text: `Pressed ${key}${check ? `\n${check.verdict}` : ''}` }],
          details: { key, verified: verifiedOf(check) },
          at: null,
        };
      }

      case 'batch':
        // A nested batch would smuggle ungated actions past the loop below.
        throw new Error('an action inside a batch cannot be another batch');

      default:
        throw new Error(`unknown action: ${String(record.action)}`);
    }
  };

  /**
   * Run a list of actions in order inside ONE tool call.
   *
   * Three properties matter here and each one cost a bug in an earlier design:
   *
   * - ONE machine lock for the whole list. The caller's exclusive-tool wrapper
   *   (the `machine` mutex in cli.ts) wraps this `execute` once, so the whole
   *   batch runs inside a single acquisition — one mouse, one keyboard, no
   *   interleaving with another conversation's tool call. Taking the lock per
   *   item instead would interleave with other threads mid-sequence.
   * - The SAME permission gate as a standalone action, once per item (see
   *   `ActionGate`). A blocked or failed item is reported and the rest are
   *   skipped: a half-applied sequence the model cannot see is worse than a
   *   shorter one it can.
   * - Post-action verification ONCE at the end, not per action: one settle, one
   *   after-capture, one verdict line. Per-action pairs share those two frames
   *   and differ only in the roi the verifier checks, which is what turns "did
   *   anything move" into "did EACH action land where it should" without paying
   *   two captures per action.
   */
  const runBatch = async (record: Record<string, unknown>, signal?: AbortSignal) => {
    const list = asActionList(record.actions);
    if (!list || list.length === 0) {
      throw new Error('the batch action requires a non-empty actions array');
    }
    // An unwired gate is a wiring bug, not a permission decision, so the batch is
    // refused before the first action rather than while running it: "blocked on
    // item 0" hides what is actually wrong, and this report must be actionable.
    if (!gate) {
      const results: BatchItemResult[] = list.map((item, index) => ({
        index,
        action: typeof item.action === 'string' ? item.action : 'unknown',
        ok: false,
        error: `blocked: ${NO_GATE_REASON}`,
      }));
      log.warn('batch refused: no permission gate is wired', { actions: list.length });
      return {
        content: [
          {
            type: 'text' as const,
            text: `${NO_GATE_REASON}. Ninguna de las ${list.length} acciones se ha ejecutado.`,
          },
        ],
        details: { results, verified: null, ...scaling },
      };
    }
    const results: BatchItemResult[] = [];
    const images: ContentBlock[] = [];
    const targets: Array<{ at: { x: number; y: number } | null }> = [];
    let before: Screenshot | null = null;
    let cutAt = -1;

    let cancelledAt = -1;
    for (let i = 0; i < list.length; i++) {
      const item = list[i] ?? {};
      const name = typeof item.action === 'string' ? item.action : 'unknown';

      // Safe stop: /stop (or a run timeout) aborts the agent run, and the rest of a
      // queued sequence must not keep clicking on the desktop after that. Checked
      // before each item, so the action in flight finishes and nothing new starts.
      if (signal?.aborted) {
        cancelledAt = i;
        break;
      }

      // The exact call shape `beforeToolCall` sends to `Gate.check`, so batch
      // items are policed by the same rules as standalone actions rather than
      // riding on the approval of the outer `batch`.
      const decision = await gate({ tool: 'computer', args: item, actor: 'batch' });
      if (decision.verdict !== 'allow') {
        results.push({ index: i, action: name, ok: false, error: `blocked: ${decision.reason}` });
        log.info('batch action blocked', { index: i, action: name, reason: decision.reason });
        cutAt = i;
        break;
      }

      try {
        if (config.verifyActions && isMutatingAction(name) && before === null) {
          before = await backend.screenshot();
        }
        const out = await runAction(item, { verifyResult: false });
        results.push({ index: i, action: name, ok: true, result: out.details });
        for (const block of out.content) {
          if (block.type === 'image') images.push(block);
        }
        if (isMutatingAction(name)) targets.push({ at: out.at });
      } catch (err) {
        results.push({
          index: i,
          action: name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        log.warn('batch action failed', { index: i, action: name, err });
        cutAt = i;
        break;
      }
    }

    if (cancelledAt >= 0) {
      log.info('batch cancelled', { at: cancelledAt, of: list.length });
      for (let j = cancelledAt; j < list.length; j++) {
        const item = list[j] ?? {};
        results.push({
          index: j,
          action: typeof item.action === 'string' ? item.action : 'unknown',
          ok: false,
          error: 'skipped: run cancelled (parada solicitada)',
        });
      }
    }

    if (cutAt >= 0) {
      for (let j = cutAt + 1; j < list.length; j++) {
        const item = list[j] ?? {};
        results.push({
          index: j,
          action: typeof item.action === 'string' ? item.action : 'unknown',
          ok: false,
          error: `skipped: action ${cutAt} did not complete`,
        });
      }
    }

    let verdict: BatchVerdict | null = null;
    const beforeShot = before;
    if (config.verifyActions && beforeShot && targets.length > 0) {
      // Long enough for a repaint to land — once for the whole batch, which is
      // where most of the saved latency lives (see `verify`).
      await sleep(config.verifySettleMs);
      const after = await backend.screenshot();
      // Each pair shares the two frames and differs in the window it checks: a
      // click's window is the 96x96 box around its point (radius 48, matching a
      // standalone click), an untargeted action counts anywhere.
      const pairs = targets.map((target) => ({
        before: beforeShot,
        after,
        roi: target.at ? expand({ ...target.at, width: 0, height: 0 }, 48) : undefined,
      }));
      verdict = await verifyBatch(pairs);
    }

    const okCount = results.filter((r) => r.ok).length;
    const text = [
      `Batch ${list.length} actions: ${okCount} ok, ${results.length - okCount} not executed.`,
      ...results.map((r) => {
        const head = `[${r.index}] ${r.action}`;
        if (r.ok) return `${head}: ok`;
        if (r.error?.startsWith('skipped')) return `${head}: ${r.error}`;
        return `${head}: FAILED — ${r.error ?? 'unknown error'}`;
      }),
      verdict ? verdict.reason : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      content: [{ type: 'text' as const, text }, ...images],
      details: {
        results,
        verified: verdict
          ? { done: verdict.done, changed: verdict.changed, total: verdict.total }
          : null,
        ...scaling,
      },
    };
  };

  return {
    name: 'computer',
    label: 'Computer',
    description: [
      'Control the desktop. Actions: screenshot (returns the screen as an image),',
      'click (x, y), move (x, y), drag (x,y to toX,toY), type (text), key (chord),',
      'batch (actions: [...]) runs several actions in one call, in order, and stops at the first failure.',
      'Coordinates are pixels in the screenshot you were shown, origin top-left.',
      'Optional roi {x, y, width, height} on screenshot and click: screenshot then returns only',
      'that region, and click x/y become relative to the roi top-left. Keep passing the same roi',
      'to clicks after a roi screenshot.',
      'For key, use chords like "enter", "ctrl+s", "alt+F4", "shift+tab" — not symbols.',
      'Always screenshot first; never guess coordinates.',
      'Every click, drag, type and keypress returns a VERIFICACION line saying whether',
      'the screen really changed (once for a whole batch). If it says it did not, do not',
      'repeat the action: take a fresh screenshot and locate the element again, because the',
      'coordinates were wrong.',
    ].join(' '),
    parameters: ComputerParams,
    // Sequential on purpose: two input actions in one batch can interleave and fight
    // over the mouse, which produces a click on the wrong thing and is very hard to
    // diagnose afterwards.
    executionMode: 'sequential',
    execute: async (_id, args, signal) => {
      const record = args as unknown as Record<string, unknown>;
      if (args.action === 'batch') return runBatch(record, signal);
      if (signal?.aborted && args.action !== 'screenshot') {
        // A queued call that arrives after /stop must not touch mouse or keyboard.
        throw new Error('cancelled: the run was stopped before this action (parada solicitada)');
      }
      const out = await runAction(record, { verifyResult: true });
      return { content: out.content, details: out.details };
    },
  };
}

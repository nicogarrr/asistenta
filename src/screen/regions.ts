/**
 * Pure rectangle geometry for regions of interest (ROIs). No I/O, no clock, no
 * dependencies: every function here is deterministic arithmetic so it can be
 * unit-tested without a screen and reused by the capture, click and verification
 * paths without dragging process spawns into the maths.
 *
 * Why ROIs exist: a full screenshot costs ~1.5k tokens and every click pays a
 * verification diff of the whole frame. Restricting both to the region the model
 * actually cares about is the cheapest available speedup once the tool calls are
 * batched.
 *
 * Coordinate space: a `Region` is always expressed in the pixel space of the
 * frame the model is working in — the same space as click `x`/`y` ("pixels in
 * the screenshot you were shown"). `scaleRegion` is the one place that converts
 * between that space and real desktop pixels.
 *
 * Conventions, chosen once so callers never have to think about them:
 * - Negative width/height are treated as 0. A region with no area is empty.
 * - Empty regions produce empty results (a null clip, a false overlap).
 */

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

function area(region: Region): { x: number; y: number; width: number; height: number } {
  return {
    x: region.x,
    y: region.y,
    width: Math.max(0, region.width),
    height: Math.max(0, region.height),
  };
}

/**
 * Intersection of `region` with `bounds`, or null when nothing is left.
 *
 * Returns null rather than a zero-sized rect because "the region is off screen"
 * and "the region is a point" need different recoveries: the first is a model
 * mistake to report, the second is valid geometry.
 */
export function clipRegion(region: Region, bounds: Region): Region | null {
  const r = area(region);
  const b = area(bounds);
  const x1 = Math.max(r.x, b.x);
  const y1 = Math.max(r.y, b.y);
  const x2 = Math.min(r.x + r.width, b.x + b.width);
  const y2 = Math.min(r.y + r.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Map `region`, read in the `from` pixel space, into the `to` pixel space.
 *
 * This is the single translation between "screenshot pixels" and "real desktop
 * pixels" (see `toRealCoordinates` in tools/computer.ts for the same maths on a
 * point). Positions are relative to each space's own origin, so a region at the
 * centre of `from` lands at the centre of `to` whatever the offsets are.
 *
 * A zero (or negative) dimension on either side returns the region unchanged
 * instead of dividing by zero: "no screenshot yet" is the honest answer and a
 * NaN coordinate is not.
 */
export function scaleRegion(region: Region, from: Region, to: Region): Region {
  const f = area(from);
  const t = area(to);
  if (f.width <= 0 || f.height <= 0 || t.width <= 0 || t.height <= 0) return region;
  const sx = t.width / f.width;
  const sy = t.height / f.height;
  return {
    x: Math.round(t.x + (region.x - f.x) * sx),
    y: Math.round(t.y + (region.y - f.y) * sy),
    width: Math.round(region.width * sx),
    height: Math.round(region.height * sy),
  };
}

/**
 * Grow `region` by `pad` pixels on every side, then keep it inside `bounds`.
 *
 * The bounds clamp is what makes this usable for "look around the click point":
 * a verification window near the edge of the screen must not ask the comparer to
 * read pixels that do not exist. When clamping empties the region entirely (the
 * input lay outside `bounds`), the result is a zero-sized region clamped to the
 * bounds rather than a throw — a degenerate window is a fact, not an error.
 */
export function expand(region: Region, pad: number, bounds?: Region): Region {
  const r = area(region);
  const grown: Region = {
    x: r.x - pad,
    y: r.y - pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2,
  };
  if (!bounds) return grown;
  const clipped = clipRegion(grown, bounds);
  if (clipped) return clipped;
  const b = area(bounds);
  return {
    x: Math.min(Math.max(grown.x, b.x), b.x + b.width),
    y: Math.min(Math.max(grown.y, b.y), b.y + b.height),
    width: 0,
    height: 0,
  };
}

/**
 * Whether `b` lies entirely inside `a`.
 *
 * Empty `b` degrades to a point check on its origin, so "is this pixel in
 * bounds" stays expressible as `regionContains(frame, { x, y, width: 0,
 * height: 0 })` without a second function.
 */
export function regionContains(a: Region, b: Region): boolean {
  const outer = area(a);
  const inner = area(b);
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Whether the two regions share at least one pixel of area.
 *
 * Strict inequalities on purpose: rects that merely touch along an edge do not
 * overlap, and an empty region overlaps nothing (checked explicitly, since a
 * zero-width rect at a point inside `a` would otherwise pass the inequality
 * form). That keeps "borderline collision" from reading as "the click landed on
 * the control".
 */
export function regionsOverlap(a: Region, b: Region): boolean {
  const r1 = area(a);
  const r2 = area(b);
  if (r1.width <= 0 || r1.height <= 0 || r2.width <= 0 || r2.height <= 0) return false;
  return (
    r1.x < r2.x + r2.width &&
    r2.x < r1.x + r1.width &&
    r1.y < r2.y + r2.height &&
    r2.y < r1.y + r1.height
  );
}

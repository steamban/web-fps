import type { Aabb, Vec3 } from "./geometry";
import type { MapData, Ramp } from "./map";

/**
 * Hand-rolled AABB collision against the map's boxes, ramps and bounds.
 *
 * Pure geometry: it knows nothing about gravity, input or player dimensions — the caller
 * hands it a box and a delta and gets back where that box ended up. `movement.ts` owns the
 * tuning; keeping the split means the same resolver serves the client prediction and the
 * server simulation in M3 without either importing the other's constants.
 */

type Axis = "x" | "y" | "z";

/**
 * Longest distance any single resolution step may cover. Anything faster is split into
 * several, so a falling player cannot pass through a floor thinner than they travel in a
 * tick. Comfortably under the thinnest geometry the maps use.
 */
const MAX_SUBSTEP_METERS = 0.1;

/**
 * Overlaps shallower than this are contact, not collision.
 *
 * A resolved move parks the player exactly on the face they hit, but movement stores a
 * position and rebuilds the box from it every step, and that round trip is not exact — so
 * resting on something reappears as a penetration around 1e-15 deep. Without a tolerance
 * that reads as a fresh collision on *every* axis, including the ones the player is only
 * sliding along, and the push-out below then ejects them the full width of whatever they
 * were leaning on. A nanometre is far beneath anything the game can express and far above
 * the error, so the two cannot be confused.
 */
const CONTACT_EPSILON = 1e-9;

export interface MoveOptions {
  /** Largest rise a slope may push the player up; anything steeper blocks like a wall. */
  readonly stepHeight: number;
  /**
   * Pull the player back down onto a surface within `stepHeight` when the move would
   * otherwise leave them airborne, so walking down a slope is a glide and not a series of
   * little hops. Only set this while the player is already standing on something.
   */
  readonly snapToGround: boolean;
}

export interface MoveResult {
  readonly box: Aabb;
  /** The move ended resting on a surface: floor, box top or ramp slope. */
  readonly grounded: boolean;
  /** The move was stopped from above, so upward velocity should be dropped. */
  readonly hitCeiling: boolean;
}

/** Shared volume only — boxes that touch, or that overlap by less than `CONTACT_EPSILON`,
 *  are not colliding. */
export function aabbOverlaps(a: Aabb, b: Aabb): boolean {
  return (
    a.min.x < b.max.x - CONTACT_EPSILON &&
    a.max.x > b.min.x + CONTACT_EPSILON &&
    a.min.y < b.max.y - CONTACT_EPSILON &&
    a.max.y > b.min.y + CONTACT_EPSILON &&
    a.min.z < b.max.z - CONTACT_EPSILON &&
    a.max.z > b.min.z + CONTACT_EPSILON
  );
}

const shift = (box: Aabb, axis: Axis, distance: number): Aabb => {
  const min = { ...box.min };
  const max = { ...box.max };
  min[axis] += distance;
  max[axis] += distance;
  return { min, max };
};

/** Slide `box` along `axis` until its low face sits at `value`. */
const placeMin = (box: Aabb, axis: Axis, value: number): Aabb =>
  shift(box, axis, value - box.min[axis]);

/** Slide `box` along `axis` until its high face sits at `value`. */
const placeMax = (box: Aabb, axis: Axis, value: number): Aabb =>
  shift(box, axis, value - box.max[axis]);

/** Back `box` out of `solid` along the axis it entered on. */
const pushOut = (box: Aabb, solid: Aabb, axis: Axis, direction: number): Aabb =>
  direction > 0 ? placeMax(box, axis, solid.min[axis]) : placeMin(box, axis, solid.max[axis]);

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * Height of a ramp's sloped surface above a horizontal point, clamped to its footprint so
 * points off the ramp report the nearest edge rather than extrapolating the plane.
 */
export function rampSurfaceHeight(ramp: Ramp, x: number, z: number): number {
  const { min, max } = ramp.box;
  const alongX = ramp.ascend === "+x" || ramp.ascend === "-x";
  const low = alongX ? min.x : min.z;
  const high = alongX ? max.x : max.z;
  const at = clamp(alongX ? x : z, low, high);
  const progress = high > low ? (at - low) / (high - low) : 1;
  const rise = ramp.ascend.startsWith("+") ? progress : 1 - progress;
  return min.y + rise * (max.y - min.y);
}

/**
 * The highest point of `ramp`'s surface beneath `box`'s footprint, or null when the two do
 * not overlap horizontally.
 *
 * Taking the highest point rather than the centre means the player is carried by whichever
 * corner of their footprint is furthest uphill. Going up that is the leading edge, so they
 * never clip into the slope; coming down it is the trailing edge, so they stay supported
 * instead of stepping off into the air.
 */
export function rampSurfaceUnder(ramp: Ramp, box: Aabb): number | null {
  const { min, max } = ramp.box;
  const lowX = Math.max(box.min.x, min.x);
  const highX = Math.min(box.max.x, max.x);
  const lowZ = Math.max(box.min.z, min.z);
  const highZ = Math.min(box.max.z, max.z);
  if (highX - lowX <= CONTACT_EPSILON || highZ - lowZ <= CONTACT_EPSILON) return null;
  return rampSurfaceHeight(
    ramp,
    ramp.ascend === "+x" ? highX : lowX,
    ramp.ascend === "+z" ? highZ : lowZ,
  );
}

function moveHorizontal(
  map: MapData,
  box: Aabb,
  axis: "x" | "z",
  distance: number,
  stepHeight: number,
): Aabb {
  let moved = shift(box, axis, distance);

  if (moved.min[axis] < map.bounds.min[axis]) moved = placeMin(moved, axis, map.bounds.min[axis]);
  if (moved.max[axis] > map.bounds.max[axis]) moved = placeMax(moved, axis, map.bounds.max[axis]);

  for (const solid of map.boxes) {
    if (aabbOverlaps(moved, solid)) moved = pushOut(moved, solid, axis, distance);
  }

  for (const ramp of map.ramps) {
    const surface = rampSurfaceUnder(ramp, moved);
    if (surface === null || surface <= moved.min.y) continue;
    moved =
      surface - moved.min.y <= stepHeight
        ? placeMin(moved, "y", surface)
        : pushOut(moved, ramp.box, axis, distance);
  }
  return moved;
}

function moveVertical(
  map: MapData,
  box: Aabb,
  distance: number,
): { box: Aabb; grounded: boolean; hitCeiling: boolean } {
  let moved = shift(box, "y", distance);
  let grounded = false;
  let hitCeiling = false;

  for (const solid of map.boxes) {
    if (!aabbOverlaps(moved, solid)) continue;
    if (distance > 0) {
      moved = placeMax(moved, "y", solid.min.y);
      hitCeiling = true;
    } else {
      moved = placeMin(moved, "y", solid.max.y);
      grounded = true;
    }
  }

  // Ramps are ground, not ceiling: nothing collides with a slope's underside.
  // ponytail: fine while every ramp sits on the floor — revisit if a map ever suspends one.
  if (distance <= 0) {
    for (const ramp of map.ramps) {
      const surface = rampSurfaceUnder(ramp, moved);
      if (surface === null || surface <= moved.min.y) continue;
      moved = placeMin(moved, "y", surface);
      grounded = true;
    }
  }

  if (moved.min.y <= map.bounds.min.y) {
    moved = placeMin(moved, "y", map.bounds.min.y);
    grounded = true;
  }
  if (moved.max.y > map.bounds.max.y) {
    moved = placeMax(moved, "y", map.bounds.max.y);
    hitCeiling = true;
  }
  return { box: moved, grounded, hitCeiling };
}

/**
 * Horizontal first, then vertical, one axis at a time. Resolving per axis is what makes a
 * player slide along a wall they run into at an angle instead of stopping dead, and what
 * keeps a diagonal run at an inside corner from squeezing through it.
 */
function sweep(map: MapData, box: Aabb, delta: Vec3, stepHeight: number): MoveResult {
  const furthest = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z));
  const steps = Math.max(1, Math.ceil(furthest / MAX_SUBSTEP_METERS));
  let current = box;
  let grounded = false;
  let hitCeiling = false;

  for (let step = 0; step < steps; step += 1) {
    current = moveHorizontal(map, current, "x", delta.x / steps, stepHeight);
    current = moveHorizontal(map, current, "z", delta.z / steps, stepHeight);
    const vertical = moveVertical(map, current, delta.y / steps);
    current = vertical.box;
    // Only the final substep describes where the player ended up; a ceiling clipped on
    // the way through still has to cancel the velocity that caused it.
    grounded = vertical.grounded;
    hitCeiling = hitCeiling || vertical.hitCeiling;
  }
  return { box: current, grounded, hitCeiling };
}

/** Move `box` by `delta` through the map's geometry and report where it came to rest. */
export function resolveMove(
  map: MapData,
  box: Aabb,
  delta: Vec3,
  options: MoveOptions,
): MoveResult {
  const swept = sweep(map, box, delta, options.stepHeight);
  if (swept.grounded || !options.snapToGround || delta.y > 0) return swept;

  const probe = sweep(map, swept.box, { x: 0, y: -options.stepHeight, z: 0 }, options.stepHeight);
  return probe.grounded ? { ...probe, hitCeiling: swept.hitCeiling } : swept;
}

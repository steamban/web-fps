import { resolveMove } from "./collision";
import type { Aabb, Vec3 } from "./geometry";
import type { MapData, SpawnPoint } from "./map";
import type { InputKeys } from "./protocol";

/**
 * One player's movement for one fixed timestep. Pure: state in, state out, no clock and
 * no I/O — the client drives it from its own loop and the server's `simulate` will fold it
 * over every player in M3.
 *
 * World units are metres and yaw is in radians. Yaw 0 faces -z, matching the camera's
 * resting direction, so forward is `(-sin yaw, 0, -cos yaw)` and right is a quarter turn
 * clockwise from it. Everything that converts an angle to a direction reads it from here.
 */

/** Player collision box: 0.6 m square, 1.8 m tall, standing on `position`. */
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
/** Camera height above the feet. */
export const PLAYER_EYE_HEIGHT = 1.65;

/** Ground speed, metres per second. */
export const MOVE_SPEED = 7;
/** Upward speed at the moment of a jump; with `GRAVITY` this peaks a little over 1.1 m. */
export const JUMP_SPEED = 7.5;
/** Downward acceleration, metres per second squared — well above real gravity, for a
 *  quick arcade arc rather than a floaty one. */
export const GRAVITY = 24;
/** Largest rise a slope may carry the player up over in one move. */
export const STEP_HEIGHT = 0.6;

/**
 * Most simulation a client's loop may catch up on in one frame. A backgrounded tab comes
 * back with a huge elapsed time; simulating a quarter second of it and dropping the rest
 * beats freezing while it works through minutes. The server sizes its per-player input
 * queue from this, since the burst a returning tab sends is a legitimate one.
 */
export const MAX_CATCHUP_MS = 250;

export interface MovementState {
  /** Horizontal centre of the player, at the height of their feet. */
  readonly position: Vec3;
  /** Metres per second. Only `y` carries between steps; the horizontal pair is derived
   *  from the keys every step and is reported for the renderer and for M6's HUD. */
  readonly velocity: Vec3;
  readonly grounded: boolean;
}

/**
 * Fold an angle onto a single turn.
 *
 * Written with `atan2` rather than by subtracting a multiple of a turn because this runs
 * on yaw that arrived over a socket: at a magnitude near `Number.MAX_VALUE` that
 * subtraction is all rounding error and lands nowhere near a turn, while sine and cosine
 * are bounded whatever they are handed. Applied to the *difference* of two angles it is
 * also the short way round, which is what interpolating a facing needs.
 */
export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function playerBox(position: Vec3): Aabb {
  return {
    min: { x: position.x - PLAYER_HALF_WIDTH, y: position.y, z: position.z - PLAYER_HALF_WIDTH },
    max: {
      x: position.x + PLAYER_HALF_WIDTH,
      y: position.y + PLAYER_HEIGHT,
      z: position.z + PLAYER_HALF_WIDTH,
    },
  };
}

export function spawnState(spawn: SpawnPoint): MovementState {
  return {
    position: { ...spawn.position },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
  };
}

/** Unit vector the held keys ask for, in world space. Normalised, so diagonals are not faster. */
function wishDirection(keys: InputKeys, yaw: number): { x: number; z: number } {
  const ahead = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const aside = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  if (ahead === 0 && aside === 0) return { x: 0, z: 0 };

  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const x = ahead * -sin + aside * cos;
  const z = ahead * -cos + aside * -sin;
  const length = Math.hypot(x, z);
  return { x: x / length, z: z / length };
}

export function stepMovement(
  state: MovementState,
  keys: InputKeys,
  yaw: number,
  dtMs: number,
  map: MapData,
): MovementState {
  const dt = dtMs / 1000;
  const wish = wishDirection(keys, yaw);

  // Arcade handling: horizontal velocity tracks the keys instantly, in the air exactly as
  // on the ground. No acceleration curve, friction or air-control penalty in v1 — the
  // movement tech those enable is deferred to v2 (see PLAN.md "Deferred").
  const vx = wish.x * MOVE_SPEED;
  const vz = wish.z * MOVE_SPEED;

  const jumping = state.grounded && keys.jump;
  let vy = (jumping ? JUMP_SPEED : state.velocity.y) - GRAVITY * dt;

  const moved = resolveMove(
    map,
    playerBox(state.position),
    { x: vx * dt, y: vy * dt, z: vz * dt },
    // Snapping down only makes sense for a player already on the ground who is not
    // leaving it; applied mid-jump it would glue them back to the floor.
    { stepHeight: STEP_HEIGHT, snapToGround: state.grounded && !jumping },
  );

  if (moved.grounded && vy < 0) vy = 0;
  if (moved.hitCeiling && vy > 0) vy = 0;

  return {
    position: {
      x: (moved.box.min.x + moved.box.max.x) / 2,
      y: moved.box.min.y,
      z: (moved.box.min.z + moved.box.max.z) / 2,
    },
    velocity: { x: vx, y: vy, z: vz },
    grounded: moved.grounded,
  };
}

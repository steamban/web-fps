import {
  type InputKeys,
  type MapData,
  type MovementState,
  type PlayerId,
  type SnapshotPlayer,
  stepMovement,
  type Vec3,
  wrapAngle,
} from "@web-fps/shared";

/**
 * The maths of staying in sync with an authoritative server, as pure functions — the
 * `controls.ts` split again: everything here is a call with an answer, and `game.ts` is
 * the loop, the socket and the renderer around it.
 *
 * Two halves, and they are deliberately different. The local player is *predicted*: their
 * input is simulated immediately and corrected when the server disagrees, because waiting
 * a round trip to turn is what makes a game feel slow. Everyone else is *interpolated*
 * between the last two snapshots, about a tick behind, because a remote player's next
 * move is not knowable and guessing it means walking them into walls.
 */

/** An input already sent, kept until the server says it has been simulated. */
export interface PendingInput {
  readonly seq: number;
  readonly keys: InputKeys;
  /**
   * The yaw this input was sent with. Replaying at the *current* camera yaw would
   * simulate a path the server never ran — spin while holding forward and the two
   * disagree by metres.
   */
  readonly yaw: number;
}

export interface Reconciled {
  readonly state: MovementState;
  /** What is still unacknowledged, and so still has to be replayed next time. */
  readonly pending: readonly PendingInput[];
}

/**
 * Rebuild the local player from the server's word, then replay everything it has not seen
 * yet. Takes no local state at all: the server's snapshot is the starting point by
 * definition, so the very first snapshot is not a special case — with nothing pending it
 * simply hands back where the server put you.
 */
export function reconcile(
  self: SnapshotPlayer,
  ackSeq: number,
  pending: readonly PendingInput[],
  map: MapData,
  dtMs: number,
): Reconciled {
  const unacked = pending.filter((input) => input.seq > ackSeq);

  // Horizontal velocity is re-derived from the keys every step, so the snapshot's
  // vertical component and `grounded` are the whole of what has to carry over.
  let state: MovementState = {
    position: self.position,
    velocity: { x: 0, y: self.velocityY, z: 0 },
    grounded: self.grounded,
  };
  for (const input of unacked) {
    state = stepMovement(state, input.keys, input.yaw, dtMs, map);
  }
  return { state, pending: unacked };
}

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/** Straight-line interpolation between two points. */
export function lerpVec3(from: Vec3, to: Vec3, t: number): Vec3 {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    z: lerp(from.z, to.z, t),
  };
}

/**
 * Interpolate a facing the short way round. Yaw wraps at +/-pi, and with yaw 0 facing -z
 * that seam is "looking towards +z" — somewhere a player stands constantly, where a plain
 * lerp would spin them a half turn to get from 3.13 to -3.13.
 */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + wrapAngle(to - from) * t;
}

/** Everything drawing a remote player needs and nothing else. */
export interface RenderedPlayer {
  readonly id: PlayerId;
  readonly position: Vec3;
  readonly yaw: number;
}

/**
 * Where to draw everyone but yourself, `fraction` of the way from the previous snapshot to
 * the latest — which puts them about a tick behind, the price of never guessing.
 */
export function interpolatePlayers(
  previous: readonly SnapshotPlayer[],
  latest: readonly SnapshotPlayer[],
  fraction: number,
  self: PlayerId,
): RenderedPlayer[] {
  // Clamped, so a stall freezes everyone where they were last seen instead of projecting
  // them through the geometry and snapping them back when the next snapshot lands.
  const t = Math.min(Math.max(fraction, 0), 1);
  const before = new Map(previous.map((player) => [player.id, player]));

  // Driven by the latest snapshot, so somebody who has left stops being drawn at once —
  // and so is somebody who has died, who is not anywhere until M5 respawns them.
  return latest
    .filter((player) => player.id !== self && player.alive)
    .map((player) => {
      // Nowhere to come from on a player's first snapshot; drawing them where they are
      // beats streaking them in from the map's origin. A player who was dead in the
      // previous one is the same case: they come back somewhere else entirely, and
      // interpolating would walk the body across the map to meet them.
      const previous = before.get(player.id);
      const from = previous?.alive ? previous : player;
      return {
        id: player.id,
        position: lerpVec3(from.position, player.position, t),
        yaw: lerpAngle(from.yaw, player.yaw, t),
      };
    });
}

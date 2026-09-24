import { describe, expect, it } from "vitest";
import { aabbOverlaps, rampSurfaceUnder } from "./collision";
import { MOVE_SPEED, type MovementState, playerBox, STEP_HEIGHT, stepMovement } from "./movement";
import type { InputKeys } from "./protocol";
import { SANDBOX_MAP } from "./sandboxMap";

/**
 * A property, rather than a case: however the player is standing and whichever way they
 * walk, one step moves them at most as far as their speed allows.
 *
 * Both collision bugs found in M2 review broke exactly this — a contact-depth overlap, or
 * an axis moved by zero, resolved into a push across the full width of an obstacle. Each
 * has a case test of its own; this is here to catch the next one of the same family, which
 * is unlikely to be reachable from either of those two positions.
 */

const TICK_MS = 1000 / 60;
const DT = TICK_MS / 1000;
/** Floating point slack, not a tolerance for real overshoot. */
const SLACK = 1e-9;

const HELD: InputKeys = { forward: true, back: false, left: false, right: false, jump: false };

/** Somewhere a player could actually be: on the floor, not inside anything. */
const isClear = (x: number, z: number): boolean => {
  const box = playerBox({ x, y: 0, z });
  return (
    !SANDBOX_MAP.boxes.some((solid) => aabbOverlaps(box, solid)) &&
    !SANDBOX_MAP.ramps.some((ramp) => rampSurfaceUnder(ramp, box) !== null)
  );
};

const starts: { x: number; z: number }[] = [];
for (let x = -21; x <= 21; x += 3) {
  for (let z = -21; z <= 21; z += 3) if (isClear(x, z)) starts.push({ x, z });
}

const YAWS = Array.from({ length: 8 }, (_, step) => (step * Math.PI) / 4);

describe("walking anywhere on the sandbox map", () => {
  it("has somewhere to walk from", () => {
    expect(starts.length).toBeGreaterThan(80);
  });

  it("never moves the player further in one step than their speed allows", () => {
    const furthest = MOVE_SPEED * DT + SLACK;
    const overshoots: string[] = [];

    for (const start of starts) {
      for (const yaw of YAWS) {
        let state: MovementState = {
          position: { x: start.x, y: 0, z: start.z },
          velocity: { x: 0, y: 0, z: 0 },
          grounded: true,
        };
        for (let tick = 0; tick < 200; tick += 1) {
          const next = stepMovement(state, HELD, yaw, TICK_MS, SANDBOX_MAP);
          const flat = Math.hypot(
            next.position.x - state.position.x,
            next.position.z - state.position.z,
          );
          // Up by a slope's step at most; down by no more than the fall already underway.
          const rise = Math.abs(next.position.y - state.position.y);
          if (flat > furthest || rise > Math.max(STEP_HEIGHT, Math.abs(state.velocity.y) * DT)) {
            overshoots.push(
              `from (${start.x}, ${start.z}) yaw ${yaw.toFixed(2)} tick ${tick}: ` +
                `flat ${flat.toFixed(3)} rise ${rise.toFixed(3)}`,
            );
            break;
          }
          state = next;
        }
      }
    }

    expect(overshoots.slice(0, 5)).toEqual([]);
  });
});

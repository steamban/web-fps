import { describe, expect, it } from "vitest";
import { aabbOverlaps, rampSurfaceHeight, rampSurfaceUnder } from "./collision";
import type { Aabb } from "./geometry";
import { type MapData, MapDataSchema, type Ramp } from "./map";
import { type MovementState, playerBox, stepMovement } from "./movement";
import type { InputKeys } from "./protocol";
import { SANDBOX_MAP } from "./sandboxMap";

/**
 * The sandbox map is hand-written data, so what is checked here is the kind of mistake
 * hand-written coordinates make: geometry buried inside other geometry, a ramp that does
 * not quite meet the platform it leads to, a spawn point inside a wall.
 */

const contains = (outer: Aabb, inner: Aabb): boolean =>
  inner.min.x >= outer.min.x &&
  inner.max.x <= outer.max.x &&
  inner.min.y >= outer.min.y &&
  inner.max.y <= outer.max.y &&
  inner.min.z >= outer.min.z &&
  inner.max.z <= outer.max.z;

/** Nowhere to stand on and nothing to hit: just the arc of a standing jump. */
const EMPTY: MapData = {
  ...SANDBOX_MAP,
  boxes: [],
  ramps: [],
};

/** How high a standing jump's feet reach when the simulation is stepped at `tickMs`. */
const apexAt = (tickMs: number): number => {
  const jump: InputKeys = { forward: false, back: false, left: false, right: false, jump: true };
  let state: MovementState = {
    position: { x: 0, y: EMPTY.bounds.min.y, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
  };
  let highest = state.position.y;
  state = stepMovement(state, jump, 0, tickMs, EMPTY);
  while (!state.grounded) {
    highest = Math.max(highest, state.position.y);
    state = stepMovement(state, { ...jump, jump: false }, 0, tickMs, EMPTY);
  }
  return highest - EMPTY.bounds.min.y;
};

describe("SANDBOX_MAP", () => {
  it("is valid map data", () => {
    const result = MapDataSchema.safeParse(SANDBOX_MAP);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("keeps every box and ramp inside the play area", () => {
    for (const box of SANDBOX_MAP.boxes) expect(contains(SANDBOX_MAP.bounds, box)).toBe(true);
    for (const ramp of SANDBOX_MAP.ramps) {
      expect(contains(SANDBOX_MAP.bounds, ramp.box)).toBe(true);
    }
  });

  it("has no geometry buried inside other geometry", () => {
    for (const [index, box] of SANDBOX_MAP.boxes.entries()) {
      for (const other of SANDBOX_MAP.boxes.slice(index + 1)) {
        expect(aabbOverlaps(box, other)).toBe(false);
      }
      for (const ramp of SANDBOX_MAP.ramps) expect(aabbOverlaps(box, ramp.box)).toBe(false);
    }
  });

  /** The footprint corner a ramp is at full height on. */
  const highEdge = (ramp: Ramp) => ({
    x: ramp.ascend === "-x" ? ramp.box.min.x : ramp.box.max.x,
    z: ramp.ascend === "-z" ? ramp.box.min.z : ramp.box.max.z,
  });

  it("lands every ramp flush with a box you can walk onto", () => {
    for (const ramp of SANDBOX_MAP.ramps) {
      const edge = highEdge(ramp);
      expect(rampSurfaceHeight(ramp, edge.x, edge.z)).toBeCloseTo(ramp.box.max.y);

      const alongX = ramp.ascend === "+x" || ramp.ascend === "-x";
      const landing = SANDBOX_MAP.boxes.find(
        (box) =>
          Math.abs(box.max.y - ramp.box.max.y) < 1e-9 &&
          // Shares the ramp's high face, and spans it on the other axis.
          (alongX
            ? Math.abs((ramp.ascend === "+x" ? box.min.x : box.max.x) - edge.x) < 1e-9 &&
              box.min.z <= ramp.box.min.z &&
              box.max.z >= ramp.box.max.z
            : Math.abs((ramp.ascend === "+z" ? box.min.z : box.max.z) - edge.z) < 1e-9 &&
              box.min.x <= ramp.box.min.x &&
              box.max.x >= ramp.box.max.x),
      );
      expect(landing).toBeDefined();
    }
  });

  it("spawns players on the floor, in the open", () => {
    for (const spawn of SANDBOX_MAP.spawns) {
      expect(spawn.position.y).toBe(SANDBOX_MAP.bounds.min.y);
      const box = playerBox(spawn.position);
      expect(contains(SANDBOX_MAP.bounds, box)).toBe(true);
      for (const solid of SANDBOX_MAP.boxes) expect(aabbOverlaps(box, solid)).toBe(false);
      for (const ramp of SANDBOX_MAP.ramps) expect(rampSurfaceUnder(ramp, box)).toBeNull();
    }
  });

  it("has no obstacle whose jumpability depends on the tick rate", () => {
    // The jump arc is integrated one step at a time, so a slower tick peaks lower: 0.99 m
    // at the server's default 20 Hz against 1.14 m at 120. A box top between the two is one
    // a player mounts in the sandbox and cannot mount in a match — and since only ramps
    // carry a player up, a box top is exactly what a jump has to clear.
    const reachable = apexAt(1000 / 20);
    const unreachable = apexAt(1000 / 120);
    expect(reachable).toBeLessThan(unreachable);

    for (const box of SANDBOX_MAP.boxes) {
      const climb = box.max.y - SANDBOX_MAP.bounds.min.y;
      expect({ climb, decided: climb < reachable || climb > unreachable }).toEqual({
        climb,
        decided: true,
      });
    }
  });

  it("gives every player somewhere different to start", () => {
    const seen = new Set(SANDBOX_MAP.spawns.map((s) => `${s.position.x},${s.position.z}`));
    expect(seen.size).toBe(SANDBOX_MAP.spawns.length);
  });
});

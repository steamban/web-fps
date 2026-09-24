import { describe, expect, it } from "vitest";
import { aabbOverlaps, rampSurfaceHeight, rampSurfaceUnder, resolveMove } from "./collision";
import type { Aabb, Vec3 } from "./geometry";
import type { MapData, Ramp } from "./map";

/**
 * The collision core. Every case here is a shape the movement step has to survive —
 * see PLAN.md M2 for the list this was written against.
 */

const STEP_HEIGHT = 0.6;
const HALF_WIDTH = 0.3;
const HEIGHT = 1.8;

/** A player box, addressed the way movement does: horizontal centre plus feet height. */
const player = (x: number, y: number, z: number): Aabb => ({
  min: { x: x - HALF_WIDTH, y, z: z - HALF_WIDTH },
  max: { x: x + HALF_WIDTH, y: y + HEIGHT, z: z + HALF_WIDTH },
});

const feet = (box: Aabb): Vec3 => ({
  x: (box.min.x + box.max.x) / 2,
  y: box.min.y,
  z: (box.min.z + box.max.z) / 2,
});

const arena = (over: Partial<MapData> = {}): MapData => ({
  name: "test",
  bounds: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 10, z: 10 } },
  boxes: [],
  ramps: [],
  spawns: [{ position: { x: 0, y: 0, z: 0 }, yaw: 0 }],
  ...over,
});

const move = (map: MapData, box: Aabb, delta: Partial<Vec3>, snapToGround = false) =>
  resolveMove(map, box, { x: 0, y: 0, z: 0, ...delta }, { stepHeight: STEP_HEIGHT, snapToGround });

/** Rises 2m over 4m of +x; its tall face is the x=4 plane. */
const slope: Ramp = {
  box: { min: { x: 0, y: 0, z: -2 }, max: { x: 4, y: 2, z: 2 } },
  ascend: "+x",
};

describe("aabbOverlaps", () => {
  const unit: Aabb = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };

  it("sees boxes that share volume", () => {
    expect(aabbOverlaps(unit, { min: { x: 0.5, y: 0.5, z: 0.5 }, max: { x: 2, y: 2, z: 2 } })).toBe(
      true,
    );
  });

  it("does not count touching faces as a collision", () => {
    // Resting exactly on a surface must not re-collide with it on the next tick.
    expect(aabbOverlaps(unit, { min: { x: 1, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } })).toBe(
      false,
    );
  });

  it("ignores boxes that only overlap on some axes", () => {
    expect(aabbOverlaps(unit, { min: { x: 0.5, y: 5, z: 0.5 }, max: { x: 2, y: 6, z: 2 } })).toBe(
      false,
    );
  });
});

describe("rampSurfaceHeight", () => {
  it("runs from the low edge to the full height along the ascend axis", () => {
    expect(rampSurfaceHeight(slope, 0, 0)).toBeCloseTo(0);
    expect(rampSurfaceHeight(slope, 2, 0)).toBeCloseTo(1);
    expect(rampSurfaceHeight(slope, 4, 0)).toBeCloseTo(2);
  });

  it("ignores the axis the ramp does not rise along", () => {
    expect(rampSurfaceHeight(slope, 2, -1.9)).toBeCloseTo(rampSurfaceHeight(slope, 2, 1.9));
  });

  it("mirrors for a ramp that ascends the other way", () => {
    const mirrored: Ramp = { ...slope, ascend: "-x" };
    expect(rampSurfaceHeight(mirrored, 0, 0)).toBeCloseTo(2);
    expect(rampSurfaceHeight(mirrored, 4, 0)).toBeCloseTo(0);
  });

  it("rises along z for a z-facing ramp", () => {
    const along: Ramp = { ...slope, ascend: "+z" };
    expect(rampSurfaceHeight(along, 0, -2)).toBeCloseTo(0);
    expect(rampSurfaceHeight(along, 0, 2)).toBeCloseTo(2);
  });

  it("clamps outside the footprint to the nearest edge", () => {
    expect(rampSurfaceHeight(slope, -50, 0)).toBeCloseTo(0);
    expect(rampSurfaceHeight(slope, 50, 0)).toBeCloseTo(2);
  });
});

describe("rampSurfaceUnder", () => {
  it("is null when the footprints do not overlap", () => {
    expect(rampSurfaceUnder(slope, player(-5, 0, 0))).toBeNull();
    expect(rampSurfaceUnder(slope, player(2, 0, 9))).toBeNull();
  });

  it("is null when the boxes only touch along an edge", () => {
    expect(rampSurfaceUnder(slope, player(-HALF_WIDTH, 0, 0))).toBeNull();
  });

  it("reports the highest surface beneath the footprint", () => {
    // Leading edge at x = 0.4 on a 0.5 gradient.
    expect(rampSurfaceUnder(slope, player(0.1, 0, 0))).toBeCloseTo(0.2);
  });

  it("never exceeds the ramp's own height", () => {
    expect(rampSurfaceUnder(slope, player(4, 0, 0))).toBeCloseTo(2);
  });
});

describe("resolveMove against the world bounds", () => {
  it("lands on the floor and reports being grounded", () => {
    const result = move(arena(), player(0, 5, 0), { y: -9 });
    expect(feet(result.box).y).toBeCloseTo(0);
    expect(result.grounded).toBe(true);
  });

  it("keeps the player inside the horizontal bounds", () => {
    const result = move(arena(), player(9.5, 0, 0), { x: 5 });
    expect(feet(result.box).x).toBeCloseTo(10 - HALF_WIDTH);
  });

  it("stops at the ceiling of the play area", () => {
    const result = move(arena(), player(0, 7, 0), { y: 5 });
    expect(result.box.max.y).toBeCloseTo(10);
    expect(result.hitCeiling).toBe(true);
  });
});

describe("resolveMove against boxes", () => {
  const wall = arena({ boxes: [{ min: { x: 2, y: 0, z: -5 }, max: { x: 3, y: 3, z: 5 } }] });

  it("stops at a wall instead of passing through it", () => {
    const result = move(wall, player(1, 0, 0), { x: 4 });
    expect(feet(result.box).x).toBeCloseTo(2 - HALF_WIDTH);
  });

  it("stops at a wall approached from the far side", () => {
    const result = move(wall, player(4, 0, 0), { x: -4 });
    expect(feet(result.box).x).toBeCloseTo(3 + HALF_WIDTH);
  });

  it("lands on top of a box", () => {
    const result = move(wall, player(2.5, 5, 0), { y: -4 });
    expect(feet(result.box).y).toBeCloseTo(3);
    expect(result.grounded).toBe(true);
  });

  it("stops under an overhang and reports the ceiling", () => {
    const overhang = arena({
      boxes: [{ min: { x: -2, y: 2.5, z: -2 }, max: { x: 2, y: 3, z: 2 } }],
    });
    const result = move(overhang, player(0, 0.5, 0), { y: 1 });
    expect(feet(result.box).y).toBeCloseTo(0.7);
    expect(result.hitCeiling).toBe(true);
    expect(result.grounded).toBe(false);
  });

  it("does not clip through an inside corner taken diagonally", () => {
    const corner = arena({
      boxes: [
        { min: { x: 2, y: 0, z: -5 }, max: { x: 3, y: 3, z: 2 } },
        { min: { x: -5, y: 0, z: 2 }, max: { x: 3, y: 3, z: 3 } },
      ],
    });
    const result = feet(move(corner, player(1.5, 0, 1.5), { x: 0.4, z: 0.4 }).box);
    expect(result.x).toBeLessThanOrEqual(2 - HALF_WIDTH + 1e-9);
    expect(result.z).toBeLessThanOrEqual(2 - HALF_WIDTH + 1e-9);
  });

  it("slides along a wall taken at an angle", () => {
    const result = feet(move(wall, player(1.5, 0, 0), { x: 0.4, z: 0.4 }).box);
    expect(result.x).toBeCloseTo(2 - HALF_WIDTH);
    expect(result.z).toBeCloseTo(0.4);
  });
});

describe("resolveMove on a ledge", () => {
  const ledge = arena({ boxes: [{ min: { x: 0, y: 0, z: -2 }, max: { x: 4, y: 1, z: 2 } }] });

  it("stays grounded while only a sliver of the footprint is over the edge", () => {
    const result = move(ledge, player(-HALF_WIDTH + 0.05, 1, 0), { y: -0.05 });
    expect(result.grounded).toBe(true);
    expect(feet(result.box).y).toBeCloseTo(1);
  });

  it("falls the moment the footprint clears the edge", () => {
    const result = move(ledge, player(-HALF_WIDTH - 0.05, 1, 0), { y: -0.05 });
    expect(result.grounded).toBe(false);
    expect(feet(result.box).y).toBeLessThan(1);
  });
});

describe("resolveMove against ramps", () => {
  const ramped = arena({ ramps: [slope] });

  it("steps the player up onto the slope", () => {
    const result = move(ramped, player(-0.2, 0, 0), { x: 0.3, y: -0.01 });
    expect(feet(result.box).y).toBeCloseTo(0.2);
    expect(result.grounded).toBe(true);
  });

  it("treats the tall face as a wall rather than a step", () => {
    const result = move(ramped, player(4.5, 0, 0), { x: -0.4 });
    expect(feet(result.box).x).toBeCloseTo(4 + HALF_WIDTH);
    expect(feet(result.box).y).toBeCloseTo(0);
  });

  it("keeps the player on the surface while walking back down", () => {
    const result = move(ramped, player(2, 1.15, 0), { x: -0.3, y: -0.05 }, true);
    expect(result.grounded).toBe(true);
    expect(feet(result.box).y).toBeCloseTo(rampSurfaceUnder(slope, result.box) ?? -1);
  });

  it("lands on the slope when dropped onto it", () => {
    const result = move(ramped, player(2, 6, 0), { y: -8 });
    expect(result.grounded).toBe(true);
    expect(feet(result.box).y).toBeCloseTo(1.15);
  });

  it("leaves a player above the slope alone", () => {
    const result = move(ramped, player(2, 4, 0), { x: 0.2 });
    expect(feet(result.box).y).toBeCloseTo(4);
    expect(result.grounded).toBe(false);
  });
});

describe("resolveMove at speed", () => {
  it("does not tunnel through a thin platform", () => {
    const thin = arena({
      boxes: [{ min: { x: -2, y: 3, z: -2 }, max: { x: 2, y: 3.2, z: 2 } }],
    });
    const result = move(thin, player(0, 5, 0), { y: -4 });
    expect(feet(result.box).y).toBeCloseTo(3.2);
    expect(result.grounded).toBe(true);
  });

  it("does not tunnel through a thin wall taken at a run", () => {
    const thin = arena({
      boxes: [{ min: { x: 2, y: 0, z: -5 }, max: { x: 2.2, y: 3, z: 5 } }],
    });
    const result = move(thin, player(0, 0, 0), { x: 6 });
    expect(feet(result.box).x).toBeCloseTo(2 - HALF_WIDTH);
  });
});

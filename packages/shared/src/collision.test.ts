import { describe, expect, it } from "vitest";
import {
  aabbOverlaps,
  rampSurfaceHeight,
  rampSurfaceUnder,
  rayHitsAabb,
  rayHitsMap,
  resolveMove,
} from "./collision";
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

  it("treats a penetration far below a visible distance as contact", () => {
    // A player resting on a face is stored as a centre and rebuilt from it next step, and
    // 0.3 does not round-trip exactly — so contact reappears as a sliver of penetration.
    expect(
      aabbOverlaps(unit, { min: { x: 1 - 1e-12, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } }),
    ).toBe(false);
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

describe("resolveMove for a player already resting against something", () => {
  /**
   * Movement keeps a position and rebuilds the box from it every step, and neither the
   * halving nor the subtraction is exact — so a player parked flush against a face comes
   * back a sliver inside it. The size is whatever double precision leaves at this scale;
   * what the resolver has to survive is that it is not zero.
   */
  const PENETRATION = 1e-15;

  const restingOn = (solid: Aabb, x: number): Aabb => ({
    min: { x: x - HALF_WIDTH, y: 0, z: solid.max.z - PENETRATION },
    max: { x: x + HALF_WIDTH, y: HEIGHT, z: solid.max.z + 0.6 - PENETRATION },
  });

  it("lets them walk along the face they are touching", () => {
    const crate: Aabb = { min: { x: -10, y: 0, z: -10 }, max: { x: -8, y: 1, z: -8 } };
    const map = arena({ boxes: [crate] });

    // Without a contact tolerance the sliver of overlap on z reads as a fresh collision on
    // x too, and the push-out ejects the player out of the crate's far side instead.
    const result = move(map, restingOn(crate, -9.4), { x: 0.05, y: -0.0066 }, true);
    expect(feet(result.box).x).toBeCloseTo(-9.35, 6);
    expect(feet(result.box).z).toBeCloseTo(-7.7, 6);
  });

  it("does not resolve an axis the move never touched", () => {
    const map = arena({ boxes: [{ min: { x: 2, y: 0, z: -5 }, max: { x: 3, y: 3, z: 5 } }] });

    // Nothing in the game puts a player inside a wall, but a move of zero along an axis
    // cannot have entered anything, so it must not invent a direction to eject them in.
    const result = move(map, player(2.5, 0, 0), { y: -0.05 }, true);
    expect(feet(result.box).x).toBeCloseTo(2.5);
    expect(feet(result.box).z).toBeCloseTo(0);
  });

  it("does not step up onto a box, however low — only ramps carry a player up", () => {
    const map = arena({ boxes: [{ min: { x: 2, y: 0, z: -5 }, max: { x: 3, y: 0.2, z: 5 } }] });
    const result = move(map, player(1, 0, 0), { x: 1, y: -0.0066 }, true);
    expect(feet(result.box).x).toBeCloseTo(2 - HALF_WIDTH);
    expect(feet(result.box).y).toBeCloseTo(0);
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

/**
 * Rays. The same geometry from the other end: not "where does this box come to rest" but
 * "what is the first thing in this direction" — which is how M4 resolves a shot.
 */

const EAST: Vec3 = { x: 1, y: 0, z: 0 };
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

/** Rises 3 m over 6 m of +x, so its surface is exactly y = x/2. */
const wedge: Ramp = {
  box: { min: { x: 0, y: 0, z: -2 }, max: { x: 6, y: 3, z: 2 } },
  ascend: "+x",
};

describe("rayHitsAabb", () => {
  const box: Aabb = { min: { x: 2, y: 0, z: -1 }, max: { x: 4, y: 2, z: 1 } };

  it("reports how far along the ray the box starts", () => {
    expect(rayHitsAabb({ x: 0, y: 1, z: 0 }, EAST, box, 10)).toBeCloseTo(2);
  });

  it("misses a box the ray goes past", () => {
    expect(rayHitsAabb({ x: 0, y: 1, z: 3 }, EAST, box, 10)).toBeNull();
  });

  it("misses a box behind the origin", () => {
    expect(rayHitsAabb({ x: 6, y: 1, z: 0 }, EAST, box, 10)).toBeNull();
  });

  it("never reaches further than the range it is given", () => {
    expect(rayHitsAabb({ x: 0, y: 1, z: 0 }, EAST, box, 1.9)).toBeNull();
    expect(rayHitsAabb({ x: 0, y: 1, z: 0 }, EAST, box, 2.1)).toBeCloseTo(2);
  });

  it("reports zero from an origin already inside the box", () => {
    // Which is exactly why a shooter has to be excluded from their own shot by id: their
    // eye is 1.65 m up inside their own 1.8 m box, so distance alone would make every
    // trigger pull a suicide.
    expect(rayHitsAabb({ x: 3, y: 1, z: 0 }, EAST, box, 10)).toBe(0);
  });

  it("treats a slab the ray runs parallel to as a containment test", () => {
    // No component of the direction may be divided by zero: inside the slab the ray can
    // still hit, outside it never can, and neither answer may come back NaN.
    expect(rayHitsAabb({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, box, 10)).toBeCloseTo(2);
    expect(rayHitsAabb({ x: 0, y: 3, z: 0 }, { x: 1, y: 0, z: 0 }, box, 10)).toBeNull();
    expect(rayHitsAabb({ x: 0, y: 1, z: 0 }, { x: 1, y: -0, z: -0 }, box, 10)).toBeCloseTo(2);
  });
});

describe("rayHitsMap", () => {
  it("finds nothing down an empty lane", () => {
    expect(rayHitsMap(arena(), { x: 0, y: 1, z: 0 }, EAST, 100)).toBeNull();
  });

  it("ignores the arena shell, which is the movement clamp and not something to shoot", () => {
    // Both the shooter and the target are inside a convex shell, so a shot between them
    // can never cross it — and a wall the map does not list is a wall nobody can see.
    expect(rayHitsMap(arena(), { x: 0, y: 1, z: 0 }, EAST, 1000)).toBeNull();
  });

  it("stops at the nearest of several solids", () => {
    const map = arena({
      boxes: [
        { min: { x: 5, y: 0, z: -1 }, max: { x: 6, y: 2, z: 1 } },
        { min: { x: 2, y: 0, z: -1 }, max: { x: 3, y: 2, z: 1 } },
      ],
    });
    expect(rayHitsMap(map, { x: 0, y: 1, z: 0 }, EAST, 100)).toBeCloseTo(2);
  });

  it("blocks a level shot where the slope rises to meet it", () => {
    // Eye height down the middle of the ramp: the surface reaches 1.65 m at x = 3.3.
    const map = arena({ ramps: [wedge] });
    expect(rayHitsMap(map, { x: -2, y: 1.65, z: 0 }, EAST, 100)).toBeCloseTo(5.3);
    expect(rayHitsMap(map, { x: -2, y: 0.2, z: 0 }, EAST, 100)).toBeCloseTo(2.4);
  });

  it("lets a shot pass over a slope it clears", () => {
    // A ramp is a wedge, not the box it is described by: over the low end there is nothing
    // there. Shooting at the box would mean an invisible wall above the slope.
    const map = arena({ ramps: [wedge] });
    expect(rayHitsMap(map, { x: -2, y: 3.5, z: 0 }, EAST, 100)).toBeNull();
    expect(rayHitsMap(map, { x: -2, y: 1, z: 5 }, EAST, 100)).toBeNull();
  });

  it("stops on the tall face a ramp is entered from above", () => {
    const map = arena({ ramps: [wedge] });
    expect(rayHitsMap(map, { x: 10, y: 1.65, z: 0 }, { x: -1, y: 0, z: 0 }, 100)).toBeCloseTo(4);
  });

  it("stops on the slope itself, shot from above", () => {
    const map = arena({ ramps: [wedge] });
    expect(rayHitsMap(map, { x: 3, y: 5, z: 0 }, DOWN, 100)).toBeCloseTo(3.5);
  });

  it("reports zero from inside a wedge", () => {
    const map = arena({ ramps: [wedge] });
    expect(rayHitsMap(map, { x: 5, y: 0.1, z: 0 }, EAST, 100)).toBe(0);
  });
});

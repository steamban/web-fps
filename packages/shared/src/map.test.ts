import { describe, expect, it } from "vitest";
import { AabbSchema } from "./geometry";
import { MapDataSchema } from "./map";

const validMap = {
  name: "warehouse",
  bounds: { min: { x: -50, y: 0, z: -50 }, max: { x: 50, y: 20, z: 50 } },
  boxes: [{ min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } }],
  ramps: [
    {
      box: { min: { x: 4, y: 0, z: 4 }, max: { x: 8, y: 2, z: 6 } },
      ascend: "+x" as const,
    },
  ],
  spawns: [{ position: { x: 0, y: 1, z: 0 }, yaw: 0 }],
};

describe("MapDataSchema", () => {
  it("accepts a well-formed map", () => {
    expect(MapDataSchema.safeParse(validMap).success).toBe(true);
  });

  it("rejects a map with no spawn points", () => {
    expect(MapDataSchema.safeParse({ ...validMap, spawns: [] }).success).toBe(false);
  });

  it("rejects an unknown ramp direction", () => {
    const bad = { ...validMap, ramps: [{ ...validMap.ramps[0], ascend: "up" }] };
    expect(MapDataSchema.safeParse(bad).success).toBe(false);
  });

  it("allows a map with no obstacles", () => {
    expect(MapDataSchema.safeParse({ ...validMap, boxes: [], ramps: [] }).success).toBe(true);
  });
});

describe("AabbSchema", () => {
  it("rejects an inverted box", () => {
    const inverted = { min: { x: 5, y: 0, z: 0 }, max: { x: 1, y: 2, z: 2 } };
    expect(AabbSchema.safeParse(inverted).success).toBe(false);
  });

  it("accepts a degenerate (zero volume) box", () => {
    const flat = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    expect(AabbSchema.safeParse(flat).success).toBe(true);
  });
});

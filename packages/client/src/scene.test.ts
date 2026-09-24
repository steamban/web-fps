import { rampSurfaceHeight, SANDBOX_MAP } from "@web-fps/shared";
import { describe, expect, it } from "vitest";
import { buildScene, rampGeometry } from "./scene";

/**
 * The renderer is judged by playing it (PLAN.md M6), with one exception: a ramp you can see
 * but not stand on, or stand on but not see, is the bug this milestone is most able to
 * ship. So the slope's drawn vertices are checked against the surface collision reads.
 */

describe("rampGeometry", () => {
  const ramp = SANDBOX_MAP.ramps[0];
  if (!ramp) throw new Error("the sandbox map has no ramps to check");

  it("puts every drawn corner on the collision surface", () => {
    const position = rampGeometry(ramp).getAttribute("position");
    expect(position.count).toBe(8);

    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const x = position.getX(vertex);
      const y = position.getY(vertex);
      const z = position.getZ(vertex);
      // Bottom corners sit on the ramp's base; top corners sit on its slope.
      const expected = vertex < 4 ? ramp.box.min.y : rampSurfaceHeight(ramp, x, z);
      expect(y).toBeCloseTo(expected, 4);
    }
  });

  it("spans exactly the ramp's footprint", () => {
    const geometry = rampGeometry(ramp);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.min.toArray()).toEqual([
      ramp.box.min.x,
      ramp.box.min.y,
      ramp.box.min.z,
    ]);
    expect(geometry.boundingBox?.max.toArray()).toEqual([
      ramp.box.max.x,
      ramp.box.max.y,
      ramp.box.max.z,
    ]);
  });
});

describe("buildScene", () => {
  it("draws the shell, the grid, every box and every ramp", () => {
    const scene = buildScene(SANDBOX_MAP);
    const meshes = scene.children.filter((child) => child.type === "Mesh");
    expect(meshes).toHaveLength(1 + SANDBOX_MAP.boxes.length + SANDBOX_MAP.ramps.length);
    expect(scene.children.some((child) => child.type === "GridHelper")).toBe(true);
  });
});

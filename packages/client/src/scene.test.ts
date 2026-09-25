import { aimDirection, rampSurfaceHeight, SANDBOX_MAP } from "@web-fps/shared";
import { Euler, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { buildScene, CAMERA_EULER_ORDER, rampGeometry } from "./scene";

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

describe("the camera's angles", () => {
  it("points exactly where the server says the player is aiming", () => {
    // The one equality combat rests on: the camera is aimed by `rotation.set(pitch, yaw, 0)`
    // and the server raycasts along `aimDirection(yaw, pitch)`. Change the euler order and
    // the two part company — shots land somewhere other than the crosshair, and a debug
    // overlay drawn from either one would agree with itself and lie about the other.
    for (let yaw = -Math.PI; yaw <= Math.PI; yaw += 0.41) {
      for (let pitch = -Math.PI / 2; pitch <= Math.PI / 2; pitch += 0.23) {
        const drawn = new Vector3(0, 0, -1).applyEuler(
          new Euler(pitch, yaw, 0, CAMERA_EULER_ORDER),
        );
        const aimed = aimDirection(yaw, pitch);
        expect(drawn.x).toBeCloseTo(aimed.x, 12);
        expect(drawn.y).toBeCloseTo(aimed.y, 12);
        expect(drawn.z).toBeCloseTo(aimed.z, 12);
      }
    }
  });
});

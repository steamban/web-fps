import { type Aabb, type MapData, type Ramp, rampSurfaceHeight } from "@web-fps/shared";
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  Scene,
} from "three";

/**
 * Turns map data into something to look at. Low-poly and flat-shaded: every surface is a
 * box, a slope or the arena shell, so there is no texture or material pipeline to build.
 *
 * Nothing here decides anything — the meshes are drawn from the same numbers the collision
 * resolver reads, and ramp faces are built from `rampSurfaceHeight` itself, so what you can
 * see and what you can stand on cannot drift apart.
 */

/** Fog and background sit darker than the shell so distance reads as haze, not as a wall. */
const HAZE_COLOR = 0x1b1f26;
const SHELL_COLOR = 0x3c424b;
const BOX_COLOR = 0x5b626d;
const RAMP_COLOR = 0x6b7381;
const GRID_COLOR = 0x4b5462;
const SKY_COLOR = 0xa8c0e0;
/** Light bouncing back off the floor. Bright enough that the ceiling, which faces away
 *  from everything, still reads as a surface rather than a void. */
const BOUNCE_COLOR = 0x4a5058;

const span = (box: Aabb) => ({
  x: box.max.x - box.min.x,
  y: box.max.y - box.min.y,
  z: box.max.z - box.min.z,
});

const middle = (box: Aabb) => ({
  x: (box.min.x + box.max.x) / 2,
  y: (box.min.y + box.max.y) / 2,
  z: (box.min.z + box.max.z) / 2,
});

const surface = (color: number, side?: typeof BackSide) =>
  new MeshLambertMaterial({ color, flatShading: true, ...(side === undefined ? {} : { side }) });

function boxMesh(box: Aabb, material: MeshLambertMaterial): Mesh {
  const size = span(box);
  const at = middle(box);
  const mesh = new Mesh(new BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.set(at.x, at.y, at.z);
  return mesh;
}

/**
 * A ramp drawn as a box whose four top corners sit on the slope. The two corners at the
 * low edge collapse onto their own bottom corners, which turns the box into the wedge and
 * costs two zero-area triangles — cheaper than a special case, and it means the visible
 * surface is literally `rampSurfaceHeight`.
 */
export function rampGeometry(ramp: Ramp): BufferGeometry {
  const { min, max } = ramp.box;
  const footprint = [
    [min.x, min.z],
    [max.x, min.z],
    [max.x, max.z],
    [min.x, max.z],
  ] as const;

  const vertices: number[] = [];
  for (const [x, z] of footprint) vertices.push(x, min.y, z);
  for (const [x, z] of footprint) vertices.push(x, rampSurfaceHeight(ramp, x, z), z);

  const indices = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6];
  for (let corner = 0; corner < 4; corner += 1) {
    const next = (corner + 1) % 4;
    indices.push(corner, 4 + next, next, corner, 4 + corner, 4 + next);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(vertices), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildScene(map: MapData): Scene {
  const scene = new Scene();
  scene.background = new Color(HAZE_COLOR);
  scene.fog = new Fog(HAZE_COLOR, 30, 110);

  // The arena shell: one inward-facing box standing in for the floor, ceiling and the four
  // walls the simulation clamps players against, so the drawing and the clamp agree by
  // construction.
  scene.add(boxMesh(map.bounds, surface(SHELL_COLOR, BackSide)));

  const floor = span(map.bounds);
  const grid = new GridHelper(
    Math.max(floor.x, floor.z),
    Math.round(Math.max(floor.x, floor.z) / 2),
    GRID_COLOR,
    GRID_COLOR,
  );
  const centre = middle(map.bounds);
  // Just clear of the floor, or it fights with it for the same pixels.
  grid.position.set(centre.x, map.bounds.min.y + 0.01, centre.z);
  scene.add(grid);

  const boxes = surface(BOX_COLOR);
  for (const box of map.boxes) scene.add(boxMesh(box, boxes));

  const ramps = surface(RAMP_COLOR);
  for (const ramp of map.ramps) scene.add(new Mesh(rampGeometry(ramp), ramps));

  scene.add(new HemisphereLight(SKY_COLOR, BOUNCE_COLOR, 2.4));
  // Steep rather than low, so the floor and the tops of boxes catch it and the flat
  // shading has something to separate one face from the next.
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(map.bounds.max.x * 0.6, map.bounds.max.y * 3, map.bounds.min.z * 0.4);
  scene.add(sun);

  return scene;
}

import type { MapData, SpawnPoint } from "./map";

/**
 * The one v1 map: a flat arena with enough shapes to judge movement against — a wall to
 * slide along, a gap to run through, crates at jumpable and unjumpable heights, and two
 * ramps onto platforms.
 *
 * The floor, ceiling and outer walls are the play-area bounds rather than boxes, so
 * `bounds` is the arena shell and everything in `boxes` is something standing in it.
 *
 * Coordinates are metres. There is one spawn per lobby seat, because nothing pushes two
 * players apart — `resolveMove` only knows about the map — so a shared spawn would leave
 * them standing inside each other for the rest of the match.
 */

/**
 * A spawn on the floor, turned to look at the middle of the arena. Forward is
 * `(-sin yaw, -cos yaw)` (see `movement.ts`), so facing the origin from `(x, z)` is
 * `atan2(x, z)` — computed rather than written out, since eight hand-typed angles are
 * eight chances to get a sign wrong and face a player into the wall behind them.
 */
const spawn = (x: number, z: number): SpawnPoint => ({
  position: { x, y: 0, z },
  yaw: Math.atan2(x, z),
});

export const SANDBOX_MAP: MapData = {
  name: "sandbox",
  bounds: { min: { x: -24, y: 0, z: -24 }, max: { x: 24, y: 12, z: 24 } },
  boxes: [
    // East platform, reached by the long ramp; high enough that the drop off it is a fall.
    { min: { x: 6, y: 0, z: -6 }, max: { x: 14, y: 3, z: 6 } },
    // North-west platform, reached by the short ramp.
    { min: { x: -8, y: 0, z: 4 }, max: { x: 0, y: 1.5, z: 10 } },
    // Only ramps carry a player up, so a box is something to jump onto or go around, never
    // to walk up. These two stay under the jump apex at every tick rate the server runs —
    // it is lower the slower the tick, 0.99 m at 20 Hz against 1.14 m at 120.
    { min: { x: -10, y: 0, z: -10 }, max: { x: -8, y: 0.8, z: -8 } },
    { min: { x: 2, y: 0, z: 10 }, max: { x: 4, y: 0.5, z: 12 } },
    // Over the apex at any rate: this one you go around.
    { min: { x: -14, y: 0, z: 2 }, max: { x: -12, y: 2.5, z: 4 } },
    // A wall in two halves — the gap between them is the corner-clipping test you can feel.
    { min: { x: -16, y: 0, z: -10 }, max: { x: -15.5, y: 3, z: -2 } },
    { min: { x: -16, y: 0, z: 2 }, max: { x: -15.5, y: 3, z: 10 } },
  ],
  ramps: [
    // Rises 3 m over 6 m onto the east platform's west face.
    { box: { min: { x: 0, y: 0, z: -2 }, max: { x: 6, y: 3, z: 2 } }, ascend: "+x" },
    // Rises 1.5 m over 6 m onto the north-west platform's south face.
    { box: { min: { x: -4, y: 0, z: 10 }, max: { x: 0, y: 1.5, z: 16 } }, ascend: "-z" },
  ],
  // Four corners and four edge midpoints: one per seat at the default lobby capacity,
  // all well clear of the geometry above and of each other.
  spawns: [
    spawn(-18, -18),
    spawn(18, -18),
    spawn(18, 18),
    spawn(-18, 18),
    spawn(0, -20),
    spawn(20, 0),
    spawn(0, 20),
    spawn(-20, 0),
  ],
};

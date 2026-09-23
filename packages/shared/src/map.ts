import { z } from "zod";
import { AabbSchema, Vec3Schema } from "./geometry";

/**
 * Map data shape. The server owns the authoritative map and ships it to clients in
 * `matchStart`, so geometry can never drift between the two sides.
 *
 * v1 geometry is deliberately just boxes and ramps — enough for the hand-rolled
 * AABB collision in M2, with no mesh/texture pipeline to build.
 */

/** Horizontal axis a ramp rises along; the ramp's low edge is the opposite face. */
export const RAMP_DIRECTIONS = ["+x", "-x", "+z", "-z"] as const;
export type RampDirection = (typeof RAMP_DIRECTIONS)[number];

export const RampSchema = z.object({
  /** Footprint and full height of the ramp; the sloped surface spans it corner to corner. */
  box: AabbSchema,
  ascend: z.enum(RAMP_DIRECTIONS),
});
export type Ramp = z.infer<typeof RampSchema>;

export const SpawnPointSchema = z.object({
  position: Vec3Schema,
  /** Facing direction in radians, applied on spawn. */
  yaw: z.number(),
});
export type SpawnPoint = z.infer<typeof SpawnPointSchema>;

export const MapDataSchema = z.object({
  name: z.string().min(1),
  /** Play area. A player leaving these bounds is clamped back in by the simulation. */
  bounds: AabbSchema,
  boxes: z.array(AabbSchema),
  ramps: z.array(RampSchema),
  /** At least one spawn, or nobody can enter the match. */
  spawns: z.array(SpawnPointSchema).min(1),
});
export type MapData = z.infer<typeof MapDataSchema>;

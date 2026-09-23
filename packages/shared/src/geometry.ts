import { z } from "zod";

/**
 * Wire-level geometry primitives. Kept separate from `protocol` and `map` so both
 * can depend on them without importing each other.
 */

export const Vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type Vec3 = z.infer<typeof Vec3Schema>;

/** Axis-aligned bounding box. `min` must be component-wise <= `max`. */
export const AabbSchema = z
  .object({
    min: Vec3Schema,
    max: Vec3Schema,
  })
  .refine((box) => box.min.x <= box.max.x && box.min.y <= box.max.y && box.min.z <= box.max.z, {
    message: "aabb min must be component-wise <= max",
  });
export type Aabb = z.infer<typeof AabbSchema>;

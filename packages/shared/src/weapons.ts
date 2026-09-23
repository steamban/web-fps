/**
 * Weapon balance data. Every player carries the identical loadout (v1 decision),
 * so this is a flat table rather than a per-player inventory.
 *
 * These are balance numbers, deliberately data here rather than env vars —
 * see PLAN.md "Configuration" for why session tunables and balance stats are split.
 */

export const WEAPON_SLOTS = ["primary", "secondary", "melee"] as const;
export type WeaponSlot = (typeof WEAPON_SLOTS)[number];

export interface WeaponStats {
  readonly name: string;
  /** Damage to an unprotected torso hit. */
  readonly damage: number;
  /** Multiplier applied to `damage` on a head hitbox hit. */
  readonly headshotMultiplier: number;
  /** Minimum milliseconds between shots. */
  readonly fireIntervalMs: number;
  /** Rounds per magazine, or `null` for weapons that never consume ammo (melee). */
  readonly magazineSize: number | null;
  /** Rounds held outside the magazine. */
  readonly reserveAmmo: number;
  readonly reloadMs: number;
  /** Maximum hitscan ray distance, in world units (1 unit = 1 metre). */
  readonly rangeMeters: number;
}

export const LOADOUT: Readonly<Record<WeaponSlot, WeaponStats>> = {
  primary: {
    name: "SMG",
    damage: 22,
    headshotMultiplier: 2,
    fireIntervalMs: 90,
    magazineSize: 30,
    reserveAmmo: 120,
    reloadMs: 1800,
    rangeMeters: 120,
  },
  secondary: {
    name: "Pistol",
    damage: 30,
    headshotMultiplier: 2.5,
    fireIntervalMs: 180,
    magazineSize: 12,
    reserveAmmo: 60,
    reloadMs: 1200,
    rangeMeters: 80,
  },
  melee: {
    name: "Knife",
    damage: 55,
    headshotMultiplier: 1,
    fireIntervalMs: 500,
    magazineSize: null,
    reserveAmmo: 0,
    reloadMs: 0,
    rangeMeters: 2.5,
  },
};

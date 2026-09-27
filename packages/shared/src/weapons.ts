/**
 * Combat balance data. Every player carries the identical loadout (v1 decision), so this is
 * a flat table rather than a per-player inventory.
 *
 * These are balance numbers, deliberately data here rather than env vars —
 * see PLAN.md "Configuration" for why session tunables and balance stats are split.
 */

/**
 * Health a player spawns with, and what the damage numbers below are measured against.
 * A whole number, like every one of them: `SnapshotPlayer.health` is an integer on the
 * wire, and a fraction there would fail the schema for the entire snapshot.
 *
 * Nothing multiplies `damage` — there is no head hitbox in v1, so every hit costs the
 * number written here and the wholeness of the table is the whole of the rounding rule.
 * See the M6 design log before reintroducing a multiplier.
 */
export const MAX_HEALTH = 100;

export const WEAPON_SLOTS = ["primary", "secondary", "melee"] as const;
export type WeaponSlot = (typeof WEAPON_SLOTS)[number];

export interface WeaponStats {
  readonly name: string;
  /** Damage to an unprotected hit anywhere. The hitbox is one box; see the M6 log. */
  readonly damage: number;
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
    fireIntervalMs: 90,
    magazineSize: 30,
    reserveAmmo: 120,
    reloadMs: 1800,
    rangeMeters: 120,
  },
  secondary: {
    name: "Pistol",
    // Three shots to a kill rather than four, which is the whole of what distinguishes it
    // from the SMG now that no multiplier does — see the M6 design log.
    damage: 34,
    fireIntervalMs: 180,
    magazineSize: 12,
    reserveAmmo: 60,
    reloadMs: 1200,
    rangeMeters: 80,
  },
  melee: {
    name: "Knife",
    damage: 55,
    fireIntervalMs: 500,
    magazineSize: null,
    reserveAmmo: 0,
    reloadMs: 0,
    rangeMeters: 2.5,
  },
};

/**
 * Whether a slot draws from a magazine at all. `magazineSize: null` is the one statement
 * of that in the table, read through here so that nothing else has to ask about the knife
 * by name.
 */
export const usesAmmo = (slot: WeaponSlot): boolean => LOADOUT[slot].magazineSize !== null;

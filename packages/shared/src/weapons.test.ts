import { describe, expect, it } from "vitest";
import { LOADOUT, WEAPON_SLOTS } from "./weapons";

describe("LOADOUT", () => {
  it("defines stats for every weapon slot", () => {
    expect(Object.keys(LOADOUT).sort()).toEqual([...WEAPON_SLOTS].sort());
  });

  it.each(WEAPON_SLOTS)("has sane numbers for %s", (slot) => {
    const weapon = LOADOUT[slot];
    expect(weapon.damage).toBeGreaterThan(0);
    expect(weapon.headshotMultiplier).toBeGreaterThanOrEqual(1);
    expect(weapon.fireIntervalMs).toBeGreaterThan(0);
    expect(weapon.rangeMeters).toBeGreaterThan(0);
    expect(weapon.reserveAmmo).toBeGreaterThanOrEqual(0);
    expect(weapon.reloadMs).toBeGreaterThanOrEqual(0);
    expect(weapon.magazineSize === null || weapon.magazineSize > 0).toBe(true);
  });

  it("gives melee unlimited ammo and no reload", () => {
    expect(LOADOUT.melee.magazineSize).toBeNull();
    expect(LOADOUT.melee.reloadMs).toBe(0);
  });
});

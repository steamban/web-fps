import { describe, expect, it } from "vitest";
import { LOADOUT, MAX_HEALTH, WEAPON_SLOTS } from "./weapons";

describe("LOADOUT", () => {
  it("defines stats for every weapon slot", () => {
    expect(Object.keys(LOADOUT).sort()).toEqual([...WEAPON_SLOTS].sort());
  });

  it.each(WEAPON_SLOTS)("has sane numbers for %s", (slot) => {
    const weapon = LOADOUT[slot];
    expect(weapon.damage).toBeGreaterThan(0);
    expect(weapon.fireIntervalMs).toBeGreaterThan(0);
    expect(weapon.rangeMeters).toBeGreaterThan(0);
    expect(weapon.reserveAmmo).toBeGreaterThanOrEqual(0);
    expect(weapon.reloadMs).toBeGreaterThanOrEqual(0);
    expect(weapon.magazineSize === null || weapon.magazineSize > 0).toBe(true);
  });

  it("keeps health and every damage value whole", () => {
    // Health travels as `z.number().int()`. A fraction anywhere in this table would reach
    // the wire, fail the snapshot schema, and drop the frame for every client at once.
    // With no multiplier anywhere, this is the entire rounding rule.
    expect(Number.isInteger(MAX_HEALTH)).toBe(true);
    for (const slot of WEAPON_SLOTS) expect(Number.isInteger(LOADOUT[slot].damage)).toBe(true);
  });

  it("leaves no weapon strictly worse than another at the default tick rate", () => {
    // The pistol is the one at risk: it is outranged and out-magazined by the SMG, so if
    // it also took longer to kill there would be no reason to carry it. Quantised to the
    // default 20 Hz tick, because that is what a shot actually costs — see
    // `fireCooldownTicks`.
    const shotsToKill = (damage: number) => Math.ceil(MAX_HEALTH / damage);
    const timeToKillMs = (slot: "primary" | "secondary") => {
      const weapon = LOADOUT[slot];
      const intervalMs = Math.max(1, Math.ceil(weapon.fireIntervalMs / 50)) * 50;
      return (shotsToKill(weapon.damage) - 1) * intervalMs;
    };

    expect(timeToKillMs("secondary")).toBeLessThanOrEqual(timeToKillMs("primary"));
    expect(shotsToKill(LOADOUT.secondary.damage)).toBeLessThan(shotsToKill(LOADOUT.primary.damage));
  });

  it("gives melee unlimited ammo and no reload", () => {
    expect(LOADOUT.melee.magazineSize).toBeNull();
    expect(LOADOUT.melee.reloadMs).toBe(0);
  });
});

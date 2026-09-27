import { LOADOUT, MOVE_SPEED } from "@web-fps/shared";
import { describe, expect, it } from "vitest";
import { advanceStride, createAudio, STRIDE_METRES, shotIsDue } from "./audio";

/**
 * The arithmetic, which is all of this file that can be wrong quietly. What a gunshot
 * sounds like is verified by listening (PLAN.md M6); that footsteps come at the right
 * cadence, and that a held trigger does not sound twice per round, cannot be.
 */

const at = (x: number, z = 0) => ({ x, y: 0, z });
/** What one step at 20 Hz can legitimately cover, with the sandbox's margin. */
const MAX_STEP = ((MOVE_SPEED * 50) / 1000) * 2;

describe("a stride", () => {
  it("rings once the player has covered one", () => {
    // One step at the walking speed and the default tick rate, which is what the caller
    // actually hands it: 0.35 m at a time, so a 2.2 m stride takes seven of them.
    const perStep = (MOVE_SPEED * 50) / 1000;
    let carried = 0;
    let steps = 0;
    for (let i = 0; i < 7; i += 1) {
      const moved = advanceStride(carried, at(0), at(perStep), true, MAX_STEP);
      carried = moved.carried;
      if (moved.step) steps += 1;
    }

    expect(steps).toBe(1);
    // What is past the stride is kept, not thrown away, or the cadence would drift.
    expect(carried).toBeCloseTo(7 * perStep - STRIDE_METRES, 6);
  });

  it("counts the ground covered, not the height", () => {
    // Falling is silent, and a jump covers no more ground than the run into it did.
    const climbed = advanceStride(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }, true, MAX_STEP);
    expect(climbed).toEqual({ carried: 0, step: false });
  });

  it("counts nothing while the player is off the ground", () => {
    expect(advanceStride(1, at(0), at(0.35), false, MAX_STEP)).toEqual({ carried: 1, step: false });
  });

  it("drops the carry on a move no step could have made", () => {
    // A respawn crosses the map in one snapshot. Without this it would ring out every
    // footstep of the distance at once.
    expect(advanceStride(2, at(0), at(40), true, MAX_STEP)).toEqual({ carried: 0, step: false });
  });
});

describe("a held trigger", () => {
  const stepMs = 50;

  it("sounds once per round the weapon can actually fire", () => {
    // The SMG's 90 ms is two ticks at 20 Hz, which is the server's own quantisation: the
    // step after a shot is too soon, the one after that is not.
    expect(shotIsDue(null, 1, stepMs)).toBe(true);
    expect(shotIsDue({ seq: 1, slot: "primary" }, 2, stepMs)).toBe(false);
    expect(shotIsDue({ seq: 1, slot: "primary" }, 3, stepMs)).toBe(true);
  });

  it("holds a slower weapon back for as long as its own interval", () => {
    const ticks = Math.ceil(LOADOUT.melee.fireIntervalMs / stepMs);
    expect(shotIsDue({ seq: 1, slot: "melee" }, ticks, stepMs)).toBe(false);
    expect(shotIsDue({ seq: 1, slot: "melee" }, 1 + ticks, stepMs)).toBe(true);
  });
});

describe("the audio graph", () => {
  it("does nothing at all where there is no audio to make", () => {
    // happy-dom and node have no AudioContext. Every call has to be a no-op rather than a
    // crash, or importing this file would take the rest of the client's tests down.
    const audio = createAudio();

    expect(() => {
      audio.resume();
      audio.listener({ x: 0, y: 1.65, z: 0 }, 0, 0);
      audio.shot("primary");
      audio.remoteShot("secondary", at(4));
      audio.footstep();
      audio.footstep(at(4));
      audio.land();
      audio.hitMarker();
      audio.dispose();
    }).not.toThrow();
  });
});

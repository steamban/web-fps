import {
  aimDirection,
  eyePosition,
  LOADOUT,
  MAX_HEALTH,
  type MapData,
  type PlayerId,
  type Vec3,
  type WeaponSlot,
} from "@web-fps/shared";
import { describe, expect, it } from "vitest";
import { fireCooldownTicks, resolveShots } from "./combat";
import { loadConfig } from "./config";
import { type GameState, type PlayerSimState, roundRules } from "./simulation";

/**
 * PLAN.md's M4 test, and the reason the simulation is a pure reducer: a ray against known
 * player positions, with no socket, no movement and no mocks in the way of the answer.
 *
 * Yaw 0 faces -z (see `movement.ts`), so a shooter at the origin facing 0 is shooting at
 * everything on the negative z axis.
 */

const DT = 1000 / 20;

const arena = (over: Partial<MapData> = {}): MapData => ({
  name: "test",
  bounds: { min: { x: -50, y: 0, z: -50 }, max: { x: 50, y: 20, z: 50 } },
  boxes: [],
  ramps: [],
  spawns: [{ position: { x: 0, y: 0, z: 0 }, yaw: 0 }],
  ...over,
});

const standing = (
  id: PlayerId,
  position: Vec3,
  over: Partial<PlayerSimState> = {},
): PlayerSimState => ({
  id,
  movement: { position, velocity: { x: 0, y: 0, z: 0 }, grounded: true },
  yaw: 0,
  pitch: 0,
  ackSeq: 0,
  health: MAX_HEALTH,
  score: 0,
  deaths: 0,
  protectedUntilTick: 0,
  respawnAtTick: null,
  nextFireTick: 0,
  ...over,
});

const game = (players: PlayerSimState[], map = arena(), tick = 4): GameState => ({
  tick,
  map,
  rules: roundRules(loadConfig({})),
  players,
});

const find = (state: GameState, id: PlayerId): PlayerSimState => {
  const player = state.players.find((candidate) => candidate.id === id);
  if (!player) throw new Error(`no player ${id}`);
  return player;
};

/**
 * A shot carries the ray the frame that fired it saw — `simulate` captures that at the
 * frame — so a test hands over the same thing rather than a weapon alone.
 */
const shot = (state: GameState, ...shooters: Array<[PlayerId, WeaponSlot]>) =>
  resolveShots(
    state,
    new Map(
      shooters.map(([id, slot]) => {
        const shooter = find(state, id);
        return [
          id,
          {
            slot,
            origin: eyePosition(shooter.movement.position),
            direction: aimDirection(shooter.yaw, shooter.pitch),
          },
        ] as const;
      }),
    ),
    DT,
  );

describe("fireCooldownTicks", () => {
  it("rounds a weapon's fire interval up to whole ticks", () => {
    // The simulation only exists at tick boundaries, so a weapon fires no faster than one
    // of them — the SMG's 90 ms becomes 100 ms at 20 Hz.
    expect(fireCooldownTicks("primary", DT)).toBe(2);
    expect(fireCooldownTicks("secondary", DT)).toBe(4);
    expect(fireCooldownTicks("melee", DT)).toBe(10);
  });

  it("never allows more than one shot per player per tick", () => {
    // True of every weapon in the table at every supported tick rate, which is what lets a
    // tick collect one requested shot per player instead of a queue of them.
    for (const rate of [20, 60, 120, 240]) {
      expect(fireCooldownTicks("primary", 1000 / rate)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("a shot", () => {
  it("hits the player it is aimed at and takes that weapon's damage off them", () => {
    const state = shot(
      game([standing("p1", { x: 0, y: 0, z: 0 }), standing("p2", { x: 0, y: 0, z: -5 })]),
      ["p1", "primary"],
    );

    expect(find(state, "p2").health).toBe(MAX_HEALTH - LOADOUT.primary.damage);
    expect(find(state, "p1").health).toBe(MAX_HEALTH);
  });

  it("misses a player standing beside the line of fire", () => {
    const state = shot(
      game([standing("p1", { x: 0, y: 0, z: 0 }), standing("p2", { x: 2, y: 0, z: -5 })]),
      ["p1", "primary"],
    );
    expect(find(state, "p2").health).toBe(MAX_HEALTH);
  });

  it("never hits the shooter, whose own eye is inside their own hitbox", () => {
    // The one exclusion that cannot be caught by playing alone: without it the first
    // trigger pull of every match is a suicide.
    const state = shot(game([standing("p1", { x: 0, y: 0, z: 0 })]), ["p1", "primary"]);
    expect(find(state, "p1").health).toBe(MAX_HEALTH);
  });

  it("stops at the nearest player on the line", () => {
    const state = shot(
      game([
        standing("p1", { x: 0, y: 0, z: 0 }),
        standing("far", { x: 0, y: 0, z: -10 }),
        standing("near", { x: 0, y: 0, z: -5 }),
      ]),
      ["p1", "primary"],
    );

    expect(find(state, "near").health).toBe(MAX_HEALTH - LOADOUT.primary.damage);
    expect(find(state, "far").health).toBe(MAX_HEALTH);
  });

  it("goes through a corpse to the player behind it", () => {
    const state = shot(
      game([
        standing("p1", { x: 0, y: 0, z: 0 }),
        standing("dead", { x: 0, y: 0, z: -5 }, { health: 0 }),
        standing("alive", { x: 0, y: 0, z: -10 }),
      ]),
      ["p1", "primary"],
    );

    expect(find(state, "alive").health).toBe(MAX_HEALTH - LOADOUT.primary.damage);
    expect(find(state, "dead").health).toBe(0);
  });

  it("does not hit a player it is standing inside, whatever it was aimed at", () => {
    // Nothing pushes two players apart — v1 has no player-vs-player collision — so they
    // can stand in each other, and each one's eye is then inside the other's box. Hitting
    // at zero distance would mean the pair kill each other looking at the sky.
    const stacked = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("p2", { x: 0, y: 0, z: 0 }),
    ]);
    expect(find(shot(stacked, ["p1", "primary"]), "p2").health).toBe(MAX_HEALTH);
  });

  it("is not blocked by the player it is standing inside either", () => {
    const stacked = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("inside", { x: 0, y: 0, z: 0 }),
      standing("ahead", { x: 0, y: 0, z: -5 }),
    ]);
    const state = shot(stacked, ["p1", "primary"]);

    expect(find(state, "ahead").health).toBeLessThan(MAX_HEALTH);
    expect(find(state, "inside").health).toBe(MAX_HEALTH);
  });

  it("reaches no further than the weapon does", () => {
    const apart = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("p2", { x: 0, y: 0, z: -10 }),
    ]);

    expect(find(shot(apart, ["p1", "melee"]), "p2").health).toBe(MAX_HEALTH);
    expect(find(shot(apart, ["p1", "primary"]), "p2").health).toBeLessThan(MAX_HEALTH);
  });

  it("is stopped by a wall between the two players", () => {
    const behindCover = game(
      [standing("p1", { x: 0, y: 0, z: 0 }), standing("p2", { x: 0, y: 0, z: -10 })],
      arena({ boxes: [{ min: { x: -3, y: 0, z: -6 }, max: { x: 3, y: 3, z: -5 } }] }),
    );
    expect(find(shot(behindCover, ["p1", "primary"]), "p2").health).toBe(MAX_HEALTH);
  });

  it("is stopped by a ramp's slope where the slope is high enough to stop it", () => {
    // Facing +x: the slope reaches eye height at x = 3.3, well before the target at x = 10.
    const east = -Math.PI / 2;
    const ramp = {
      box: { min: { x: 0, y: 0, z: -2 }, max: { x: 6, y: 3, z: 2 } },
      ascend: "+x" as const,
    };
    const players = [
      standing("p1", { x: -2, y: 0, z: 0 }, { yaw: east }),
      standing("p2", { x: 10, y: 0, z: 0 }),
    ];

    expect(
      find(shot(game(players, arena({ ramps: [ramp] })), ["p1", "primary"]), "p2").health,
    ).toBe(MAX_HEALTH);
    // The same shot with the ramp taken away, to prove it was the slope that stopped it.
    expect(find(shot(game(players), ["p1", "primary"]), "p2").health).toBe(
      MAX_HEALTH - LOADOUT.primary.damage,
    );
  });

  it("goes where the shooter is looking, up as well as along", () => {
    const players = [
      // Aimed at the chest of someone standing 3 m up and 6 m away.
      standing("p1", { x: 0, y: 0, z: 0 }, { pitch: Math.atan2(3.9 - 1.65, 6) }),
      standing("p2", { x: 0, y: 3, z: -6 }),
    ];

    expect(find(shot(game(players), ["p1", "primary"]), "p2").health).toBeLessThan(MAX_HEALTH);
    // Level, the same shot passes under them.
    const level = [players[0] ? { ...players[0], pitch: 0 } : standing("p1", { x: 0, y: 0, z: 0 })];
    expect(find(shot(game([...level, ...players.slice(1)]), ["p1", "primary"]), "p2").health).toBe(
      MAX_HEALTH,
    );
  });

  it("leaves the state it was given untouched", () => {
    const before = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("p2", { x: 0, y: 0, z: -5 }),
    ]);
    const snapshot = structuredClone(before);
    shot(before, ["p1", "primary"]);
    expect(before).toEqual(snapshot);
  });

  it("changes nothing at all when nobody pulled a trigger", () => {
    const before = game([standing("p1", { x: 0, y: 0, z: 0 })]);
    expect(resolveShots(before, new Map(), DT)).toBe(before);
  });
});

describe("the fire cooldown", () => {
  const pair = (tick: number, nextFireTick: number) =>
    game(
      [
        standing("p1", { x: 0, y: 0, z: 0 }, { nextFireTick }),
        standing("p2", { x: 0, y: 0, z: -5 }),
      ],
      arena(),
      tick,
    );

  it("starts after a shot and expires when the weapon is ready again", () => {
    const fired = shot(pair(4, 0), ["p1", "primary"]);
    expect(find(fired, "p1").nextFireTick).toBe(4 + fireCooldownTicks("primary", DT));

    expect(find(shot(pair(5, 6), ["p1", "primary"]), "p2").health).toBe(MAX_HEALTH);
    expect(find(shot(pair(6, 6), ["p1", "primary"]), "p2").health).toBeLessThan(MAX_HEALTH);
  });

  it("cannot be skipped by switching weapons", () => {
    // One clock for all three slots. Per-weapon cooldowns would let a player alternate
    // between them and fire at the sum of their rates.
    expect(find(shot(pair(5, 6), ["p1", "melee"]), "p2").health).toBe(MAX_HEALTH);
  });

  it("is spent whether the shot hit anything or not", () => {
    const missed = shot(game([standing("p1", { x: 0, y: 0, z: 0 })]), ["p1", "primary"]);
    expect(find(missed, "p1").nextFireTick).toBeGreaterThan(missed.tick);
  });

  it("is never spent by a dead player", () => {
    const state = shot(
      game([
        standing("p1", { x: 0, y: 0, z: 0 }, { health: 0 }),
        standing("p2", { x: 0, y: 0, z: -5 }),
      ]),
      ["p1", "primary"],
    );
    expect(find(state, "p2").health).toBe(MAX_HEALTH);
  });
});

describe("a kill", () => {
  const dying = (health: number) =>
    game([standing("p1", { x: 0, y: 0, z: 0 }), standing("p2", { x: 0, y: 0, z: -5 }, { health })]);

  it("takes the victim to zero health rather than below it", () => {
    const state = shot(dying(10), ["p1", "primary"]);
    expect(find(state, "p2").health).toBe(0);
  });

  it("credits the shooter and counts against the victim", () => {
    const state = shot(dying(10), ["p1", "primary"]);
    expect(find(state, "p1").score).toBe(1);
    expect(find(state, "p2").deaths).toBe(1);
  });

  it("is counted once, not again every tick the body lies there", () => {
    const dead = shot(dying(10), ["p1", "primary"]);
    const again = shot({ ...dead, tick: dead.tick + 10 }, ["p1", "primary"]);

    expect(find(again, "p1").score).toBe(1);
    expect(find(again, "p2").deaths).toBe(1);
  });

  it("lets two players who shoot each other in the same tick both die", () => {
    // Every shot is resolved against the state the tick left behind, so a trade is a trade
    // — whoever the requests happen to be iterated in first does not get to survive it.
    const facing = game([
      standing("p1", { x: 0, y: 0, z: 0 }, { health: 10 }),
      standing("p2", { x: 0, y: 0, z: -5 }, { health: 10, yaw: Math.PI }),
    ]);
    const state = shot(facing, ["p1", "primary"], ["p2", "primary"]);

    expect(find(state, "p1").health).toBe(0);
    expect(find(state, "p2").health).toBe(0);
    expect(find(state, "p1").score).toBe(1);
    expect(find(state, "p2").score).toBe(1);
  });

  it("sums what several shooters land on one player in the same tick", () => {
    const crossfire = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("victim", { x: 0, y: 0, z: -5 }, { health: 50 }),
      standing("p3", { x: 0, y: 0, z: -10 }, { yaw: Math.PI }),
    ]);
    const state = shot(crossfire, ["p1", "primary"], ["p3", "primary"]);

    expect(find(state, "victim").health).toBe(50 - 2 * LOADOUT.primary.damage);
  });

  it("does not depend on the order the shots were requested in", () => {
    const crossfire = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("victim", { x: 0, y: 0, z: -5 }, { health: 30 }),
      standing("p3", { x: 0, y: 0, z: -10 }, { yaw: Math.PI }),
    ]);

    expect(shot(crossfire, ["p1", "primary"], ["p3", "primary"])).toEqual(
      shot(crossfire, ["p3", "primary"], ["p1", "primary"]),
    );
  });
});

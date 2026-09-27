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
import { fireCooldownTicks, reloadTicks, resolveShots } from "./combat";
import { loadConfig } from "./config";
import { fullAmmo, type GameState, type PlayerSimState, roundRules } from "./simulation";

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
  ammo: fullAmmo(),
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
  fire(state, ...shooters).state;

/** The same tick, kept whole, for the cases that read the events it produced. */
const fire = (state: GameState, ...shooters: Array<[PlayerId, WeaponSlot]>) =>
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
    const resolved = resolveShots(before, new Map(), DT);
    // The same object, not an equal one: a tick nobody fired in has changed nothing.
    expect(resolved.state).toBe(before);
    expect(resolved.events).toEqual([]);
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

describe("the events a tick reports", () => {
  const facing = (over: Partial<PlayerSimState> = {}) =>
    game([standing("p1", { x: 0, y: 0, z: 0 }), standing("p2", { x: 0, y: 0, z: -5 }, over)]);

  it("reports every trigger pulled, whether or not it hit anything", () => {
    // A miss changes no snapshot field, so without this frame half of a firefight is
    // silent to everybody but the person shooting.
    const wide = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("p2", { x: 20, y: 0, z: -5 }),
    ]);
    const { events } = fire(wide, ["p1", "primary"]);

    expect(events).toEqual([{ type: "shot", shooterId: "p1", slot: "primary" }]);
  });

  it("reports a hit with what it cost and what the target has left", () => {
    const { events } = fire(facing(), ["p1", "primary"]);

    expect(events).toContainEqual({
      type: "hit",
      shooterId: "p1",
      targetId: "p2",
      slot: "primary",
      damage: LOADOUT.primary.damage,
      remainingHealth: MAX_HEALTH - LOADOUT.primary.damage,
    });
  });

  it("reports no hit for a shot a spawn-protected target swallowed", () => {
    // The bullet stopped on them and cost them nothing. A marker for that teaches the
    // shooter their aim was right when the shot did nothing at all.
    const { events, state } = fire(facing({ protectedUntilTick: 99 }), ["p1", "primary"]);

    expect(events.filter((event) => event.type === "hit")).toEqual([]);
    expect(find(state, "p2").health).toBe(MAX_HEALTH);
  });

  it("names the killer, the weapon and the countdown on a death", () => {
    // The pistol, not the default primary: the slot on the line is the one that fired,
    // and a test that only ever used one weapon could not tell the difference.
    const { events, state } = fire(facing({ health: 10 }), ["p1", "secondary"]);
    const dead = find(state, "p2");

    expect(events).toContainEqual({
      type: "death",
      victimId: "p2",
      killerId: "p1",
      slot: "secondary",
      // The same tick the victim's own countdown is set to; the feed and the snapshot
      // cannot disagree about when they come back.
      respawnAtTick: dead.respawnAtTick,
    });
  });

  it("reports a death for each half of a trade", () => {
    const traded = fire(
      game([
        standing("p1", { x: 0, y: 0, z: 0 }, { health: 10 }),
        standing("p2", { x: 0, y: 0, z: -5 }, { health: 10, yaw: Math.PI }),
      ]),
      ["p1", "primary"],
      ["p2", "primary"],
    );

    expect(traded.events.filter((event) => event.type === "death")).toHaveLength(2);
  });

  it("tells both shooters the same remaining health when they land in one tick", () => {
    // Shots are resolved against a frozen world, so there is no per-shot order to
    // subtract in — the number is what the target has left after the whole tick.
    const crossfire = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("victim", { x: 0, y: 0, z: -5 }, { health: 90 }),
      standing("p3", { x: 0, y: 0, z: -10 }, { yaw: Math.PI }),
    ]);
    const hits = fire(crossfire, ["p1", "primary"], ["p3", "primary"]).events.filter(
      (event) => event.type === "hit",
    );

    expect(hits).toHaveLength(2);
    for (const hit of hits) expect(hit.remainingHealth).toBe(90 - 2 * LOADOUT.primary.damage);
  });

  it("reports the same events whatever order the shots were requested in", () => {
    const crossfire = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("victim", { x: 0, y: 0, z: -5 }, { health: 30 }),
      standing("p3", { x: 0, y: 0, z: -10 }, { yaw: Math.PI }),
    ]);

    expect(fire(crossfire, ["p1", "primary"], ["p3", "primary"]).events).toEqual(
      fire(crossfire, ["p3", "primary"], ["p1", "primary"]).events,
    );
  });
});

describe("a magazine", () => {
  const facing = (over: Partial<PlayerSimState> = {}) =>
    game([standing("p1", { x: 0, y: 0, z: 0 }, over), standing("p2", { x: 0, y: 0, z: -5 })]);

  const withRounds = (slot: "primary" | "secondary", magazine: number, reserve = 60) => ({
    ammo: { ...fullAmmo(), [slot]: { magazine, reserve, reloadingUntilTick: 0 } },
  });

  it("loses a round to every shot, hit or miss", () => {
    const full = LOADOUT.primary.magazineSize ?? 0;
    const state = shot(facing(), ["p1", "primary"]);
    expect(find(state, "p1").ammo.primary.magazine).toBe(full - 1);
  });

  it("costs the knife nothing", () => {
    const close = game([
      standing("p1", { x: 0, y: 0, z: 0 }),
      standing("p2", { x: 0, y: 0, z: -1.5 }),
    ]);
    const state = shot(close, ["p1", "melee"]);

    expect(find(state, "p2").health).toBeLessThan(MAX_HEALTH);
    expect(find(state, "p1").ammo.melee).toEqual(fullAmmo().melee);
  });

  it("starts reloading on the round that empties it, not on the one after", () => {
    const state = shot(facing(withRounds("primary", 1)), ["p1", "primary"]);
    const ammo = find(state, "p1").ammo.primary;

    expect(ammo.magazine).toBe(0);
    expect(ammo.reloadingUntilTick).toBe(state.tick + reloadTicks("primary", DT));
  });

  it("refuses a trigger pulled on an empty one, at no cost at all", () => {
    // Nothing leaves the barrel, so nothing is traced, the cooldown is not spent, and
    // spawn protection survives — it is given up by buying ground while invulnerable,
    // which a dry click does not do.
    const dry = facing({ ...withRounds("primary", 0), protectedUntilTick: 99, nextFireTick: 0 });
    const state = shot(dry, ["p1", "primary"]);
    const shooter = find(state, "p1");

    expect(find(state, "p2").health).toBe(MAX_HEALTH);
    expect(shooter.nextFireTick).toBe(0);
    expect(shooter.protectedUntilTick).toBe(99);
  });

  it("leaves the other weapons usable while it refills", () => {
    // The fire cooldown is shared so that switching cannot outpace either weapon; the
    // reload is not, or emptying one gun would put the whole loadout away.
    const empty = facing({ ...withRounds("primary", 0), nextFireTick: 0 });
    const state = shot(empty, ["p1", "secondary"]);

    expect(find(state, "p2").health).toBe(MAX_HEALTH - LOADOUT.secondary.damage);
  });
});

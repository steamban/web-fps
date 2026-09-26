import {
  LOADOUT,
  MAX_HEALTH,
  MOVE_SPEED,
  type PlayerId,
  SANDBOX_MAP,
  type SpawnPoint,
  spawnState,
  stepMovement,
} from "@web-fps/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import {
  createGame,
  type GameState,
  matchStartFor,
  type PlayerInput,
  retainPlayers,
  roundRules,
  simulate,
  snapshotFor,
} from "./simulation";

/**
 * The authoritative simulation, proved without a socket in sight — which is the whole
 * reason it is a pure reducer (PLAN.md "Server simulation as a pure reducer").
 */

const config = loadConfig({});
const DT = config.tickIntervalMs;

const HELD = { forward: true, back: false, left: false, right: false, jump: false };
const RELEASED = { forward: false, back: false, left: false, right: false, jump: false };

const input = (playerId: PlayerId, seq: number, over: Partial<PlayerInput> = {}): PlayerInput => ({
  playerId,
  seq,
  keys: HELD,
  yaw: 0,
  pitch: 0,
  fire: null,
  ...over,
});

const RULES = roundRules(config);
/** Most of what is tested here is not about the opening seconds, and a protected player
 *  cannot be shot — so the rules a shot is fired under are the ones with no protection
 *  in them. `spawn protection` below uses the configured default. */
const RULES_UNPROTECTED = roundRules(loadConfig({ SPAWN_PROTECTION_SECONDS: "0" }));

const gameOf = (...ids: PlayerId[]): GameState => createGame(SANDBOX_MAP, ids, RULES_UNPROTECTED);

/** A corpse as `resolveShots` would leave one: no health, and a countdown running. */
const kill = (state: GameState, id: PlayerId): GameState => ({
  ...state,
  players: state.players.map((player) =>
    player.id === id
      ? { ...player, health: 0, respawnAtTick: state.tick + state.rules.respawnTicks }
      : player,
  ),
});

/** A player put somewhere other than the spawn they were seated at. */
const standAt = (state: GameState, id: PlayerId, x: number, z: number): GameState => ({
  ...state,
  players: state.players.map((player) =>
    player.id === id
      ? { ...player, movement: { ...player.movement, position: { x, y: 0, z } } }
      : player,
  ),
});

/** One player's line of a snapshot, which is where `spawnProtected` is derived. */
const snapshotOf = (state: GameState, id: PlayerId) => {
  const message = snapshotFor(state, id);
  return message.type === "snapshot"
    ? message.players.find((player) => player.id === id)
    : undefined;
};

const find = (state: GameState, id: PlayerId) => {
  const player = state.players.find((candidate) => candidate.id === id);
  if (!player) throw new Error(`no player ${id}`);
  return player;
};

/** One player, off the ground. A freshly spawned player is not grounded, so the first
 *  step only lands them; the jump is the second. */
const jumped = (): GameState => {
  const landed = simulate(gameOf("p1"), [input("p1", 1, { keys: RELEASED })], DT);
  return simulate(landed, [input("p1", 2, { keys: { ...RELEASED, jump: true } })], DT);
};

describe("createGame", () => {
  it("seats each player at their own spawn, facing the way the map says", () => {
    const state = gameOf("p1", "p2", "p3");

    for (const [index, player] of state.players.entries()) {
      const spawn = SANDBOX_MAP.spawns[index];
      expect(player.movement.position).toEqual(spawn?.position);
      expect(player.yaw).toBe(spawn?.yaw);
      expect(player.ackSeq).toBe(0);
    }
    expect(state.tick).toBe(0);
  });

  it("seats everyone at full health, unscored, and ready to fire", () => {
    for (const player of gameOf("p1", "p2").players) {
      expect(player).toMatchObject({ health: MAX_HEALTH, score: 0, deaths: 0, nextFireTick: 0 });
    }
  });

  it("wraps round to the first spawn if a map ever has fewer than the lobby seats", () => {
    const cramped = { ...SANDBOX_MAP, spawns: SANDBOX_MAP.spawns.slice(0, 2) };
    const state = createGame(cramped, ["p1", "p2", "p3"], RULES);
    expect(find(state, "p3").movement.position).toEqual(cramped.spawns[0]?.position);
  });
});

describe("simulate", () => {
  it("replays the same inputs to the same state", () => {
    // The milestone's own test (PLAN.md M3): given the same state and inputs, the same
    // state out — no clock, no randomness, and nothing mutated on the way through.
    const start = gameOf("p1", "p2");
    const inputs = [input("p1", 1), input("p2", 1, { keys: RELEASED, yaw: 1 })];
    const before = structuredClone(start);

    const once = simulate(simulate(start, inputs, DT), [input("p1", 2)], DT);
    const twice = simulate(simulate(start, inputs, DT), [input("p1", 2)], DT);

    expect(once).toEqual(twice);
    expect(start).toEqual(before);
  });

  it("advances one tick per call however many inputs arrive", () => {
    const state = simulate(gameOf("p1"), [input("p1", 1), input("p1", 2)], DT);
    expect(state.tick).toBe(1);
  });

  it("applies every queued input for a player and acks the last", () => {
    // Client and server both step at the tick rate off unsynchronised clocks, so two input
    // frames periodically land inside one tick. Simulating only the newest would leave the
    // server permanently a step behind a prediction the client has already dropped at ack.
    const from = SANDBOX_MAP.spawns[0]?.position.z ?? 0;
    const one = simulate(gameOf("p1"), [input("p1", 1)], DT);
    const two = simulate(gameOf("p1"), [input("p1", 1), input("p1", 2)], DT);

    const single = (one.players[0]?.movement.position.z ?? 0) - from;
    expect((two.players[0]?.movement.position.z ?? 0) - from).toBeCloseTo(2 * single, 6);
    expect(two.players[0]?.ackSeq).toBe(2);
  });

  it("ignores an input it has already simulated", () => {
    // A resent or reordered seq must not move the player twice. This guard is also what
    // makes `ackSeq: 0` mean "nothing acknowledged" and nothing else.
    const once = simulate(gameOf("p1"), [input("p1", 1)], DT);
    const again = simulate(once, [input("p1", 1), input("p1", 1)], DT);

    const idle = simulate(once, [], DT);
    expect(again.players[0]?.movement.position).toEqual(idle.players[0]?.movement.position);
    expect(again.players[0]?.ackSeq).toBe(1);
  });

  it("keeps a player with no input in the air", () => {
    // Gravity only advances inside a step, so a player whose frame is late still has to
    // move — and their ack must not move, or the client drops an input it never saw applied.
    const airborne = jumped();
    const next = simulate(airborne, [], DT);

    expect(next.players[0]?.movement.grounded).toBe(false);
    expect(next.players[0]?.movement.velocity.y).toBeLessThan(
      airborne.players[0]?.movement.velocity.y ?? 0,
    );
    expect(next.players[0]?.ackSeq).toBe(2);
  });

  it("releases the keys of a player who sent nothing rather than repeating them", () => {
    const running = simulate(gameOf("p1"), [input("p1", 1)], DT);
    const coasting = simulate(running, [], DT);

    // Horizontal movement stops the tick their input does; repeating it would walk them
    // into geometry the server never heard them ask for.
    expect(coasting.players[0]?.movement.position.x).toBeCloseTo(
      running.players[0]?.movement.position.x ?? Number.NaN,
    );
    expect(coasting.players[0]?.movement.position.z).toBeCloseTo(
      running.players[0]?.movement.position.z ?? Number.NaN,
    );
  });

  it("moves each player only by their own input", () => {
    const state = simulate(gameOf("p1", "p2"), [input("p1", 1)], DT);
    expect(find(state, "p2").movement.position).toEqual(SANDBOX_MAP.spawns[1]?.position);
    expect(find(state, "p1").movement.position).not.toEqual(SANDBOX_MAP.spawns[0]?.position);
  });

  it("runs the identical step the client predicts with", () => {
    // Prediction only works if both sides call the same function with the same arguments.
    const state = simulate(gameOf("p1"), [input("p1", 1, { yaw: 0.7 })], DT);
    const spawn = SANDBOX_MAP.spawns[0];
    const predicted = stepMovement(
      {
        position: spawn?.position ?? { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        grounded: false,
      },
      HELD,
      0.7,
      DT,
      SANDBOX_MAP,
    );
    expect(state.players[0]?.movement).toEqual(predicted);
  });

  it("does not step a player who is dead", () => {
    // A corpse neither walks nor falls. Without this the no-input branch below would keep
    // applying gravity to it, and its own frames would walk it away from where it died.
    const dead = kill(jumped(), "p1");
    const next = simulate(dead, [input("p1", 5)], DT);

    expect(find(next, "p1").movement).toEqual(find(dead, "p1").movement);
    expect(simulate(dead, [], DT).players[0]?.movement).toEqual(find(dead, "p1").movement);
  });

  it("still acknowledges a dead player's inputs", () => {
    // Their client keeps its unacknowledged frames until the server names them. Never
    // acking would leave `reconcile` replaying the same buffer for as long as they lie there.
    const next = simulate(kill(jumped(), "p1"), [input("p1", 5), input("p1", 6)], DT);
    expect(find(next, "p1").ackSeq).toBe(6);
  });

  it("folds a yaw from the wire onto a single turn", () => {
    // Yaw is unbounded on the wire. Left as sent, a hostile value overflows the difference
    // the client takes to interpolate a facing and poisons the mesh's rotation with NaN.
    const state = simulate(gameOf("p1"), [input("p1", 1, { yaw: 1e308 })], DT);
    const yaw = find(state, "p1").yaw;

    expect(Number.isFinite(yaw)).toBe(true);
    expect(Math.abs(yaw)).toBeLessThanOrEqual(Math.PI);
  });
});

describe("a shot taken on an input frame", () => {
  /**
   * Two players in the clear lane along the map's west edge, five metres apart, the first
   * looking down it at the second. Yaw 0 faces -z.
   */
  const lane = (shooterX = -20, targetX = -20): GameState => {
    const base = gameOf("p1", "p2");
    return {
      ...base,
      players: base.players.map((player, index) => ({
        ...player,
        yaw: 0,
        movement: {
          position: { x: index === 0 ? shooterX : targetX, y: 0, z: index === 0 ? 0 : -5 },
          velocity: { x: 0, y: 0, z: 0 },
          grounded: true,
        },
      })),
    };
  };

  it("damages the player it is aimed at and nobody else", () => {
    const state = simulate(lane(), [input("p1", 1, { keys: RELEASED, fire: "primary" })], DT);

    expect(find(state, "p2").health).toBe(MAX_HEALTH - LOADOUT.primary.damage);
    expect(find(state, "p1").health).toBe(MAX_HEALTH);
  });

  it("resolves the shot against where the tick left everyone, not where it found them", () => {
    // The target starts just clear of the line and steps onto it inside the same tick. A
    // shot resolved before the movement would be a systematic tick of lead on every
    // moving target — over half a player's width at this speed and tick rate.
    const stepping = [
      input("p1", 1, { keys: RELEASED, fire: "primary" }),
      input("p2", 1, { keys: { ...RELEASED, left: true } }),
    ];

    expect(find(simulate(lane(-20, -19.4), stepping, DT), "p2").health).toBeLessThan(MAX_HEALTH);
    // Standing still, the same shot goes past them.
    const standing = [input("p1", 1, { keys: RELEASED, fire: "primary" })];
    expect(find(simulate(lane(-20, -19.4), standing, DT), "p2").health).toBe(MAX_HEALTH);
  });

  it("traces the shot along the aim of the frame that fired it", () => {
    // Two frames land in one tick whenever the two clocks drift — which M3 designed the
    // fold around. The shot belongs to the frame that pulled the trigger, so a flick on
    // the frame after it cannot drag the bullet with it.
    const state = simulate(
      lane(),
      [
        input("p1", 1, { keys: RELEASED, fire: "primary" }),
        input("p1", 2, { keys: RELEASED, yaw: 1 }),
      ],
      DT,
    );
    expect(find(state, "p2").health).toBeLessThan(MAX_HEALTH);
  });

  it("does not drag a shot onto a target the player turned towards after taking it", () => {
    const state = simulate(
      lane(),
      [
        input("p1", 1, { keys: RELEASED, yaw: 1, fire: "primary" }),
        input("p1", 2, { keys: RELEASED }),
      ],
      DT,
    );
    expect(find(state, "p2").health).toBe(MAX_HEALTH);
  });

  it("fires once a tick however many frames carry a trigger, and the last one wins", () => {
    // Both frames are simulated — that is what keeps prediction honest — but a tick is one
    // shot, so the weapon named by the last of them is the one that goes off. Melee cannot
    // reach five metres, so this is a miss where the first frame alone would have hit.
    const state = simulate(
      lane(),
      [
        input("p1", 1, { keys: RELEASED, fire: "primary" }),
        input("p1", 2, { keys: RELEASED, fire: "melee" }),
      ],
      DT,
    );
    expect(find(state, "p2").health).toBe(MAX_HEALTH);
  });

  it("does not fire on a frame it has already simulated", () => {
    // A replayed frame takes its shot with it, so a resend cannot shoot twice.
    const once = simulate(lane(), [input("p1", 1, { keys: RELEASED, fire: "primary" })], DT);
    const again = simulate(once, [input("p1", 1, { keys: RELEASED, fire: "primary" })], DT);
    expect(find(again, "p2").health).toBe(find(once, "p2").health);
  });

  it("is not taken by a player who is dead", () => {
    const state = simulate(
      kill(lane(), "p1"),
      [input("p1", 1, { keys: RELEASED, fire: "primary" })],
      DT,
    );
    expect(find(state, "p2").health).toBe(MAX_HEALTH);
  });

  it("replays to the same state, shot and all", () => {
    const start = lane();
    const inputs = [input("p1", 1, { keys: RELEASED, fire: "primary" })];
    const before = structuredClone(start);

    expect(simulate(start, inputs, DT)).toEqual(simulate(start, inputs, DT));
    expect(start).toEqual(before);
  });
});

describe("retainPlayers", () => {
  it("drops everyone who has left and leaves the rest untouched", () => {
    const state = simulate(gameOf("p1", "p2", "p3"), [input("p2", 1)], DT);
    const after = retainPlayers(state, new Set(["p1", "p2"]));

    expect(after.players.map((player) => player.id)).toEqual(["p1", "p2"]);
    expect(find(after, "p2")).toEqual(find(state, "p2"));
  });

  it("never seats someone who is not already playing", () => {
    const state = gameOf("p1");
    expect(retainPlayers(state, new Set(["p1", "late"])).players).toHaveLength(1);
  });
});

describe("snapshotFor", () => {
  it("acks the recipient's own last simulated input and nobody else's", () => {
    const state = simulate(gameOf("p1", "p2"), [input("p1", 4), input("p2", 9)], DT);

    expect(snapshotFor(state, "p1")).toMatchObject({ type: "snapshot", tick: 1, ackSeq: 4 });
    expect(snapshotFor(state, "p2")).toMatchObject({ ackSeq: 9 });
  });

  it("acks nothing for a player the server has not simulated an input from", () => {
    expect(snapshotFor(gameOf("p1"), "p1")).toMatchObject({ ackSeq: 0 });
  });

  it("carries the state a recipient needs to replay its own inputs", () => {
    const state = jumped();
    const snapshot = snapshotFor(state, "p1");
    const player = snapshot.type === "snapshot" ? snapshot.players[0] : undefined;

    expect(player).toMatchObject({
      id: "p1",
      position: find(state, "p1").movement.position,
      velocityY: find(state, "p1").movement.velocity.y,
      grounded: false,
    });
    expect(player).toMatchObject({
      health: MAX_HEALTH,
      alive: true,
      score: 0,
      deaths: 0,
      // Nothing protects a spawn until M5 introduces the timer that would expire.
      spawnProtected: false,
    });
  });

  it("reports a player at zero health as dead", () => {
    // `alive` is derived rather than stored: two representations of one fact disagree the
    // moment a write site updates one of them.
    const snapshot = snapshotFor(kill(gameOf("p1"), "p1"), "p1");
    const player = snapshot.type === "snapshot" ? snapshot.players[0] : undefined;
    expect(player).toMatchObject({ health: 0, alive: false });
  });

  it("describes every player, not just the recipient", () => {
    const snapshot = snapshotFor(gameOf("p1", "p2"), "p1");
    expect(snapshot.type === "snapshot" && snapshot.players.map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("matchStartFor", () => {
  it("tells each recipient the spawn it was actually seated at", () => {
    const state = gameOf("p1", "p2");

    for (const player of state.players) {
      expect(matchStartFor(state, config, player)).toMatchObject({
        type: "matchStart",
        tickRateHz: config.tickRateHz,
        killLimit: config.killLimit,
        timeLimitMs: config.timeLimitMs,
        map: SANDBOX_MAP,
        spawn: { position: player.movement.position, yaw: player.yaw },
      });
    }
  });

  it("quotes the quantised time limit, not the configured one", () => {
    // 6.6 s at 7 Hz is 46.2 ticks, so the match actually runs 47 of them. A client
    // counting down to the configured number would reach zero with the match still on.
    const odd = loadConfig({ TICK_RATE_HZ: "7", TIME_LIMIT_MINUTES: "0.11" });
    const state = createGame(SANDBOX_MAP, ["p1"], roundRules(odd));

    for (const player of state.players) {
      expect(matchStartFor(state, odd, player)).toMatchObject({ timeLimitMs: 6714 });
    }
  });

  it("gives two players different spawns", () => {
    const state = gameOf("p1", "p2");
    const spawns = state.players.map((player) => matchStartFor(state, config, player));
    expect(spawns[0]).not.toEqual(spawns[1]);
  });
});

describe("respawning", () => {
  const quick = roundRules(loadConfig({ RESPAWN_SECONDS: "0.1" }));
  const twoSpawns = {
    ...SANDBOX_MAP,
    spawns: [SANDBOX_MAP.spawns[0], SANDBOX_MAP.spawns[1]].filter((spawn) => spawn !== undefined),
  };

  it("holds a player at zero health until the tick their death named", () => {
    let state = kill(createGame(SANDBOX_MAP, ["p1", "p2"], quick), "p1");
    expect(find(state, "p1").respawnAtTick).toBe(2);

    state = simulate(state, [], DT);
    expect(find(state, "p1")).toMatchObject({ health: 0, respawnAtTick: 2 });

    state = simulate(state, [], DT);
    expect(find(state, "p1")).toMatchObject({ health: MAX_HEALTH, respawnAtTick: null });
  });

  it("brings them back at a spawn, upright and unmoving", () => {
    const dead = kill(createGame(SANDBOX_MAP, ["p1", "p2"], quick), "p1");
    const back = find(simulate(simulate(dead, [], DT), [], DT), "p1");
    const spawn = SANDBOX_MAP.spawns.find(
      (candidate) =>
        candidate.position.x === back.movement.position.x &&
        candidate.position.z === back.movement.position.z,
    );

    expect(spawn).toBeDefined();
    expect(back.movement).toEqual(spawnState(spawn as SpawnPoint));
    expect(back.yaw).toBe(spawn?.yaw);
  });

  it("picks the spawn furthest from whoever is still alive", () => {
    // p2 is standing on p1's own spawn — the camp this rule exists to answer. p1 comes
    // back at the other end of the map instead of under their feet.
    const camped = standAt(kill(createGame(twoSpawns, ["p1", "p2"], quick), "p1"), "p2", -18, -18);
    const back = find(simulate(simulate(camped, [], DT), [], DT), "p1");

    expect(back.movement.position).toEqual(twoSpawns.spawns[1]?.position);
  });

  it("does not put two players who died together on the same spawn", () => {
    // Resolved one at a time: whoever came back first is somebody the next one keeps away
    // from. Taken as one pass, both would read the same danger and land in the same place.
    let state = createGame(twoSpawns, ["p1", "p2", "p3"], quick);
    state = kill(kill(standAt(state, "p1", 0, 0), "p2"), "p3");
    const back = simulate(simulate(state, [], DT), [], DT);

    expect(find(back, "p2").movement.position).not.toEqual(find(back, "p3").movement.position);
  });

  it("keeps what they had scored and what it had cost them", () => {
    const dead = kill(createGame(SANDBOX_MAP, ["p1", "p2"], quick), "p1");
    const state: GameState = {
      ...dead,
      players: dead.players.map((player) =>
        player.id === "p1" ? { ...player, score: 3, deaths: 2 } : player,
      ),
    };
    const back = find(simulate(simulate(state, [], DT), [], DT), "p1");

    expect(back).toMatchObject({ score: 3, deaths: 2 });
  });
});

describe("spawn protection", () => {
  // Spawn 0 and spawn 1 are 36 m apart along a clear lane; yaw -pi/2 looks down it.
  const brief = roundRules(loadConfig({ SPAWN_PROTECTION_SECONDS: "0.1", RESPAWN_SECONDS: "0.1" }));
  const lane = () => createGame(SANDBOX_MAP, ["p1", "p2"], brief);
  /** Spawn 0 shoots up the lane at yaw -pi/2; spawn 1 shoots back down it at +pi/2. */
  const shot = (id: PlayerId, seq: number, yaw = -Math.PI / 2): PlayerInput =>
    input(id, seq, { keys: RELEASED, yaw, fire: "primary" });

  it("costs a fresh spawn nothing, and stops costing them nothing", () => {
    // The milestone's own test (PLAN.md M5): protection expires and damage lands again.
    const shielded = simulate(lane(), [shot("p1", 1)], DT);
    expect(find(shielded, "p2").health).toBe(MAX_HEALTH);
    expect(snapshotOf(shielded, "p2")).toMatchObject({ spawnProtected: true });

    // Tick 2 is the last protected one; the cooldown means the next shot lands on 3.
    let state = shielded;
    for (const seq of [2, 3]) state = simulate(state, [shot("p1", seq)], DT);

    expect(find(state, "p2").health).toBe(MAX_HEALTH - LOADOUT.primary.damage);
    expect(snapshotOf(state, "p2")).toMatchObject({ spawnProtected: false });
  });

  it("is given up by firing, so it cannot be shot from behind", () => {
    // p2 is protected until tick 2 but takes a shot of their own on tick 1, which p1's
    // shot on the same tick therefore lands. Both are resolved against one frozen world.
    const traded = simulate(lane(), [shot("p1", 1), shot("p2", 1, Math.PI / 2)], DT);

    expect(find(traded, "p1").health).toBe(MAX_HEALTH - LOADOUT.primary.damage);
    expect(find(traded, "p2").health).toBe(MAX_HEALTH - LOADOUT.primary.damage);
    expect(snapshotOf(traded, "p1")).toMatchObject({ spawnProtected: false });
  });

  it("still leaves a protected player as something a bullet stops on", () => {
    // p3 stands behind p2 on the same lane. Firing through a protected body would make
    // spawn protection a window rather than a shield.
    const three = createGame(SANDBOX_MAP, ["p1", "p2", "p3"], brief);
    const behind = standAt(three, "p3", 18, -20);
    const state = simulate(standAt(behind, "p2", 18, -18), [shot("p1", 1)], DT);

    expect(find(state, "p3").health).toBe(MAX_HEALTH);
  });

  it("covers a respawn as well as a kickoff", () => {
    const dead = kill(createGame(SANDBOX_MAP, ["p1", "p2"], brief), "p1");
    const back = simulate(simulate(dead, [], DT), [], DT);

    expect(snapshotOf(back, "p1")).toMatchObject({ health: MAX_HEALTH, spawnProtected: true });
  });
});

describe("roundRules", () => {
  it("counts the configured limits in whole ticks", () => {
    const rules = roundRules(loadConfig({}));

    expect(rules).toEqual({
      killLimit: 30,
      timeLimitTicks: 600_000 / 50,
      respawnTicks: 100,
      protectionTicks: 100,
    });
  });

  it("rounds a limit up rather than cutting it short", () => {
    // 3 Hz: 5 s of respawn is 15 ticks, and 14 would hand the player back early.
    const rules = roundRules(loadConfig({ TICK_RATE_HZ: "3" }));

    expect(rules.respawnTicks).toBe(15);
    expect(rules.protectionTicks).toBe(15);
  });

  it("leaves a match at least one tick to be played in", () => {
    // `matchStart.timeLimitMs` is a positive integer on the wire, and a match that ends
    // before it has stepped has no state to end from.
    const rules = roundRules(loadConfig({ TIME_LIMIT_MINUTES: "0.0000001" }));

    expect(rules.timeLimitTicks).toBe(1);
  });
});

describe("the step a player takes", () => {
  it("never moves them further than their speed allows", () => {
    // The same property movementSweep.test.ts asserts for the client, restated where the
    // server decides it: a tick's worth of input is a tick's worth of travel, not a burst.
    let state = gameOf("p1");
    for (let seq = 1; seq <= 40; seq += 1) {
      const before = find(state, "p1").movement.position;
      state = simulate(state, [input("p1", seq)], DT);
      const after = find(state, "p1").movement.position;
      expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThanOrEqual(
        (MOVE_SPEED * DT) / 1000 + 1e-9,
      );
    }
  });
});

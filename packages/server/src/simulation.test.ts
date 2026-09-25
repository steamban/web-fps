import { MOVE_SPEED, type PlayerId, SANDBOX_MAP, stepMovement } from "@web-fps/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import {
  createGame,
  type GameState,
  matchStartFor,
  type PlayerInput,
  retainPlayers,
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

const gameOf = (...ids: PlayerId[]): GameState => createGame(SANDBOX_MAP, ids);

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

  it("wraps round to the first spawn if a map ever has fewer than the lobby seats", () => {
    const cramped = { ...SANDBOX_MAP, spawns: SANDBOX_MAP.spawns.slice(0, 2) };
    const state = createGame(cramped, ["p1", "p2", "p3"]);
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

  it("folds a yaw from the wire onto a single turn", () => {
    // Yaw is unbounded on the wire. Left as sent, a hostile value overflows the difference
    // the client takes to interpolate a facing and poisons the mesh's rotation with NaN.
    const state = simulate(gameOf("p1"), [input("p1", 1, { yaw: 1e308 })], DT);
    const yaw = find(state, "p1").yaw;

    expect(Number.isFinite(yaw)).toBe(true);
    expect(Math.abs(yaw)).toBeLessThanOrEqual(Math.PI);
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
    // Nothing in M3 can hurt anyone or score, so these are constants until M4 and M5.
    expect(player).toMatchObject({ health: 100, alive: true, spawnProtected: false, score: 0 });
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

  it("gives two players different spawns", () => {
    const state = gameOf("p1", "p2");
    const spawns = state.players.map((player) => matchStartFor(state, config, player));
    expect(spawns[0]).not.toEqual(spawns[1]);
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

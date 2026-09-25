import {
  type InputKeys,
  MOVE_SPEED,
  SANDBOX_MAP,
  type SnapshotPlayer,
  stepMovement,
} from "@web-fps/shared";
import { describe, expect, it } from "vitest";
import { interpolatePlayers, lerpAngle, type PendingInput, reconcile } from "./netcode";

/**
 * The netcode maths. Every case here is a way the client and the server can end up
 * disagreeing about where somebody is — which is invisible in a test that only checks
 * the happy path, and obvious the moment you play it.
 */

const DT = 1000 / 20;

const keys = (held: Partial<InputKeys> = {}): InputKeys => ({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  ...held,
});

const FORWARD = keys({ forward: true });

const snapshotPlayer = (over: Partial<SnapshotPlayer> = {}): SnapshotPlayer => ({
  id: "p1",
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  velocityY: 0,
  grounded: true,
  health: 100,
  alive: true,
  spawnProtected: false,
  score: 0,
  deaths: 0,
  ...over,
});

const pending = (seq: number, yaw = 0, held = FORWARD): PendingInput => ({ seq, keys: held, yaw });

describe("reconcile", () => {
  it("returns exactly the server's state when nothing is unacknowledged", () => {
    // The first snapshot of a match goes through this same call, so it must not need a
    // local state to start from — otherwise a fresh client renders at the map's origin.
    const self = snapshotPlayer({ position: { x: 3, y: 1, z: -4 }, velocityY: -2 });
    const { state, pending: left } = reconcile(self, 7, [], SANDBOX_MAP, DT);

    expect(state).toEqual({
      position: { x: 3, y: 1, z: -4 },
      velocity: { x: 0, y: -2, z: 0 },
      grounded: true,
    });
    expect(left).toEqual([]);
  });

  it("drops what the server has simulated and keeps the rest", () => {
    const { pending: left } = reconcile(
      snapshotPlayer(),
      2,
      [pending(1), pending(2), pending(3), pending(4)],
      SANDBOX_MAP,
      DT,
    );
    expect(left.map((input) => input.seq)).toEqual([3, 4]);
  });

  it("replays each input with the yaw it was sent with", () => {
    // Holding forward while turning: the server ran each input at the yaw on that frame,
    // so replaying both at the newest one walks the prediction somewhere else entirely.
    const self = snapshotPlayer();
    const { state } = reconcile(self, 0, [pending(1, 0), pending(2, Math.PI / 2)], SANDBOX_MAP, DT);

    const start = { position: self.position, velocity: { x: 0, y: 0, z: 0 }, grounded: true };
    const asSent = stepMovement(
      stepMovement(start, FORWARD, 0, DT, SANDBOX_MAP),
      FORWARD,
      Math.PI / 2,
      DT,
      SANDBOX_MAP,
    );
    const asIfLive = stepMovement(
      stepMovement(start, FORWARD, Math.PI / 2, DT, SANDBOX_MAP),
      FORWARD,
      Math.PI / 2,
      DT,
      SANDBOX_MAP,
    );

    expect(state.position).toEqual(asSent.position);
    expect(state.position).not.toEqual(asIfLive.position);
  });

  it("restores grounded so a replayed jump still leaves the floor", () => {
    // Defaulting `grounded` to false instead of reading it means the jump is refused on
    // every replay — a player who can never jump again after their first snapshot.
    const { state } = reconcile(
      snapshotPlayer({ grounded: true }),
      0,
      [pending(1, 0, keys({ jump: true }))],
      SANDBOX_MAP,
      DT,
    );
    expect(state.position.y).toBeGreaterThan(0);
  });

  it("restores the fall already under way", () => {
    const falling = reconcile(
      snapshotPlayer({ position: { x: 0, y: 5, z: 0 }, velocityY: -8, grounded: false }),
      0,
      [pending(1)],
      SANDBOX_MAP,
      DT,
    );
    const fresh = reconcile(
      snapshotPlayer({ position: { x: 0, y: 5, z: 0 }, velocityY: 0, grounded: false }),
      0,
      [pending(1)],
      SANDBOX_MAP,
      DT,
    );
    expect(falling.state.position.y).toBeLessThan(fresh.state.position.y);
  });

  it("moves the player no further than one step per replayed input", () => {
    const { state } = reconcile(snapshotPlayer(), 0, [pending(1), pending(2)], SANDBOX_MAP, DT);
    expect(Math.hypot(state.position.x, state.position.z)).toBeLessThanOrEqual(
      (2 * MOVE_SPEED * DT) / 1000 + 1e-9,
    );
  });
});

describe("lerpAngle", () => {
  it("interpolates the ordinary way when there is no seam to cross", () => {
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(lerpAngle(-1, 1, 0.25)).toBeCloseTo(-0.5);
  });

  it("takes the short way across the wrap rather than spinning a half turn", () => {
    // Yaw 0 faces -z, so this seam is "looking towards +z" — a direction someone is
    // pointed for a good part of every match.
    expect(Math.abs(lerpAngle(3.13, -3.13, 0.5))).toBeCloseTo(Math.PI, 2);
    expect(Math.abs(lerpAngle(-3.13, 3.13, 0.5))).toBeCloseTo(Math.PI, 2);
  });

  it("ends where it was asked to", () => {
    expect(Math.cos(lerpAngle(3.13, -3.13, 1))).toBeCloseTo(Math.cos(-3.13));
    expect(Math.sin(lerpAngle(3.13, -3.13, 1))).toBeCloseTo(Math.sin(-3.13));
  });
});

describe("interpolatePlayers", () => {
  const at = (id: string, x: number, yaw = 0) =>
    snapshotPlayer({ id, position: { x, y: 0, z: 0 }, yaw });

  it("puts a player between the two snapshots", () => {
    const drawn = interpolatePlayers([at("a", 0)], [at("a", 4)], 0.25, "me");
    expect(drawn).toEqual([{ id: "a", position: { x: 1, y: 0, z: 0 }, yaw: 0 }]);
  });

  it("leaves the local player out — the camera is already inside them", () => {
    expect(interpolatePlayers([at("me", 0)], [at("me", 4)], 0.5, "me")).toEqual([]);
  });

  it("draws a player's first snapshot where they are, not sliding in from the origin", () => {
    const drawn = interpolatePlayers([], [at("a", 18)], 0.3, "me");
    expect(drawn[0]?.position.x).toBe(18);
  });

  it("stops drawing a player the server says is dead", () => {
    // A corpse is not drawn and, until M5 respawns them, not there at all. game.ts drops
    // the mesh of anyone it is not handed, so nothing else has to know about death.
    const dead = { ...at("a", 4), alive: false, health: 0 };
    expect(interpolatePlayers([at("a", 0)], [dead, at("b", 1)], 0.5, "me")).toHaveLength(1);
  });

  it("stops drawing anyone the latest snapshot no longer has", () => {
    const drawn = interpolatePlayers([at("a", 0), at("gone", 5)], [at("a", 4)], 0.5, "me");
    expect(drawn.map((player) => player.id)).toEqual(["a"]);
  });

  it("clamps a stalled fraction instead of extrapolating through the map", () => {
    // Snapshots stop for half a second and the elapsed fraction reaches ten; without the
    // clamp everyone slides ten steps past where they were last seen, walls included.
    const drawn = interpolatePlayers([at("a", 0)], [at("a", 4)], 10, "me");
    expect(drawn[0]?.position.x).toBe(4);
    expect(interpolatePlayers([at("a", 0)], [at("a", 4)], -3, "me")[0]?.position.x).toBe(0);
  });

  it("turns a player the short way round", () => {
    const drawn = interpolatePlayers([at("a", 0, 3.13)], [at("a", 0, -3.13)], 0.5, "me");
    expect(Math.abs(drawn[0]?.yaw ?? 0)).toBeCloseTo(Math.PI, 2);
  });
});

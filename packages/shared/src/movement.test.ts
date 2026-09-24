import { describe, expect, it } from "vitest";
import type { MapData } from "./map";
import {
  GRAVITY,
  JUMP_SPEED,
  MOVE_SPEED,
  type MovementState,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  playerBox,
  spawnState,
  stepMovement,
} from "./movement";
import type { InputKeys } from "./protocol";

/**
 * Movement feel, expressed as assertions. The collision cases live in `collision.test.ts`;
 * what is covered here is what the keys, gravity and the jump do on top of them.
 */

const TICK_MS = 1000 / 60;
const DT = TICK_MS / 1000;

const keys = (held: Partial<InputKeys> = {}): InputKeys => ({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  ...held,
});

const arena = (over: Partial<MapData> = {}): MapData => ({
  name: "test",
  bounds: { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 20, z: 20 } },
  boxes: [],
  ramps: [],
  spawns: [{ position: { x: 0, y: 0, z: 0 }, yaw: 0 }],
  ...over,
});

const standing = (x = 0, y = 0, z = 0): MovementState => ({
  position: { x, y, z },
  velocity: { x: 0, y: 0, z: 0 },
  grounded: true,
});

const run = (
  map: MapData,
  from: MovementState,
  held: InputKeys,
  yaw: number,
  ticks: number,
): MovementState => {
  let state = from;
  for (let tick = 0; tick < ticks; tick += 1) state = stepMovement(state, held, yaw, TICK_MS, map);
  return state;
};

/** Highest the player's feet get over a run, which is what a jump is judged by. */
const peak = (map: MapData, from: MovementState, held: InputKeys, ticks: number): number => {
  let state = from;
  let highest = from.position.y;
  for (let tick = 0; tick < ticks; tick += 1) {
    state = stepMovement(state, held, 0, TICK_MS, map);
    highest = Math.max(highest, state.position.y);
  }
  return highest;
};

describe("playerBox", () => {
  it("is centred horizontally on the position and rises from its feet", () => {
    const box = playerBox({ x: 2, y: 3, z: -4 });
    expect(box.min.x).toBeCloseTo(2 - PLAYER_HALF_WIDTH);
    expect(box.max.x).toBeCloseTo(2 + PLAYER_HALF_WIDTH);
    expect(box.min.y).toBeCloseTo(3);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(-4);
  });
});

describe("spawnState", () => {
  it("starts still at the spawn point", () => {
    const state = spawnState({ position: { x: 1, y: 2, z: 3 }, yaw: 1 });
    expect(state.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(state.grounded).toBe(false);
  });
});

describe("walking", () => {
  const map = arena();

  it("goes nowhere with no keys held", () => {
    const state = run(map, standing(), keys(), 0, 10);
    expect(state.position.x).toBeCloseTo(0);
    expect(state.position.z).toBeCloseTo(0);
  });

  it("walks toward -z at yaw 0", () => {
    const state = stepMovement(standing(), keys({ forward: true }), 0, TICK_MS, map);
    expect(state.position.z).toBeCloseTo(-MOVE_SPEED * DT, 5);
    expect(state.position.x).toBeCloseTo(0);
  });

  it("walks backward toward +z", () => {
    const state = stepMovement(standing(), keys({ back: true }), 0, TICK_MS, map);
    expect(state.position.z).toBeCloseTo(MOVE_SPEED * DT, 5);
  });

  it("strafes right toward +x at yaw 0", () => {
    const state = stepMovement(standing(), keys({ right: true }), 0, TICK_MS, map);
    expect(state.position.x).toBeCloseTo(MOVE_SPEED * DT, 5);
  });

  it("turns the movement with the look direction", () => {
    // Facing -pi/2 points forward down +x.
    const state = stepMovement(standing(), keys({ forward: true }), -Math.PI / 2, TICK_MS, map);
    expect(state.position.x).toBeCloseTo(MOVE_SPEED * DT, 5);
    expect(state.position.z).toBeCloseTo(0);
  });

  it("is no faster diagonally than straight", () => {
    const straight = run(map, standing(), keys({ forward: true }), 0, 30);
    const diagonal = run(map, standing(), keys({ forward: true, right: true }), 0, 30);
    expect(Math.hypot(diagonal.position.x, diagonal.position.z)).toBeCloseTo(
      Math.hypot(straight.position.x, straight.position.z),
      5,
    );
  });

  it("stays inside the map bounds", () => {
    const state = run(map, standing(), keys({ forward: true }), 0, 600);
    expect(state.position.z).toBeCloseTo(-20 + PLAYER_HALF_WIDTH);
  });
});

describe("gravity", () => {
  const map = arena();

  it("pulls a player down onto the floor and stops there", () => {
    const state = run(map, { ...standing(0, 5, 0), grounded: false }, keys(), 0, 120);
    expect(state.position.y).toBeCloseTo(0);
    expect(state.grounded).toBe(true);
    expect(state.velocity.y).toBe(0);
  });

  it("accelerates while falling", () => {
    const first = stepMovement({ ...standing(0, 5, 0), grounded: false }, keys(), 0, TICK_MS, map);
    expect(first.velocity.y).toBeCloseTo(-GRAVITY * DT, 5);
    const second = stepMovement(first, keys(), 0, TICK_MS, map);
    expect(second.velocity.y).toBeCloseTo(-2 * GRAVITY * DT, 5);
  });

  it("clears downward velocity on landing", () => {
    const state = run(map, { ...standing(0, 0.2, 0), grounded: false }, keys(), 0, 30);
    expect(state.velocity.y).toBe(0);
  });
});

describe("jumping", () => {
  const map = arena();

  it("leaves the ground and comes back to it", () => {
    const airborne = stepMovement(standing(), keys({ jump: true }), 0, TICK_MS, map);
    expect(airborne.grounded).toBe(false);
    expect(airborne.velocity.y).toBeCloseTo(JUMP_SPEED - GRAVITY * DT, 5);

    const landed = run(map, airborne, keys(), 0, 120);
    expect(landed.grounded).toBe(true);
    expect(landed.position.y).toBeCloseTo(0);
  });

  it("rises about a metre", () => {
    const highest = peak(map, standing(), keys({ jump: true }), 60);
    expect(highest).toBeGreaterThan(1);
    expect(highest).toBeLessThan(1.25);
  });

  it("cannot be repeated in mid-air", () => {
    const airborne: MovementState = { ...standing(0, 5, 0), grounded: false };
    const state = stepMovement(airborne, keys({ jump: true }), 0, TICK_MS, map);
    expect(state.velocity.y).toBeCloseTo(-GRAVITY * DT, 5);
  });

  it("clears a one-metre crate", () => {
    const crate = arena({ boxes: [{ min: { x: 1, y: 0, z: -4 }, max: { x: 8, y: 1, z: 4 } }] });
    const jumped = run(crate, standing(), keys({ forward: true, jump: true }), -Math.PI / 2, 20);
    const landed = run(crate, jumped, keys({ forward: true }), -Math.PI / 2, 40);
    expect(landed.position.y).toBeCloseTo(1);
    expect(landed.grounded).toBe(true);
  });

  it("cannot clear a crate taller than the jump", () => {
    const crate = arena({ boxes: [{ min: { x: 1, y: 0, z: -4 }, max: { x: 8, y: 1.5, z: 4 } }] });
    const state = run(crate, standing(), keys({ forward: true, jump: true }), -Math.PI / 2, 60);
    expect(state.position.x).toBeCloseTo(1 - PLAYER_HALF_WIDTH);
    expect(state.position.y).toBeLessThan(1.5);
  });

  it("stops dead against a ceiling", () => {
    const roofed = arena({
      boxes: [{ min: { x: -4, y: 2.2, z: -4 }, max: { x: 4, y: 3, z: 4 } }],
    });
    const jumped = stepMovement(standing(), keys({ jump: true }), 0, TICK_MS, roofed);
    const state = run(roofed, jumped, keys(), 0, 3);
    expect(state.position.y + PLAYER_HEIGHT).toBeCloseTo(2.2);
    expect(state.velocity.y).toBe(0);
  });
});

describe("walls and ramps", () => {
  it("stops at a wall run into head on", () => {
    const map = arena({ boxes: [{ min: { x: -4, y: 0, z: -6 }, max: { x: 4, y: 3, z: -5 } }] });
    const state = run(map, standing(), keys({ forward: true }), 0, 60);
    expect(state.position.z).toBeCloseTo(-5 + PLAYER_HALF_WIDTH);
  });

  /** A 4 m slope rising 2 m onto a platform flush with its top edge. */
  const ramped = arena({
    boxes: [{ min: { x: -2, y: 0, z: -10 }, max: { x: 2, y: 2, z: -4 } }],
    ramps: [{ box: { min: { x: -2, y: 0, z: -4 }, max: { x: 2, y: 2, z: 0 } }, ascend: "-z" }],
  });

  it("walks up a ramp and onto the platform at the top", () => {
    const state = run(ramped, standing(), keys({ forward: true }), 0, 60);
    expect(state.position.y).toBeCloseTo(2);
    expect(state.position.z).toBeLessThan(-4);
    expect(state.grounded).toBe(true);
  });

  it("stays on the slope walking back down instead of hopping off it", () => {
    const up = run(ramped, standing(), keys({ forward: true }), 0, 20);
    const down = run(ramped, up, keys({ back: true }), 0, 10);
    expect(up.position.y).toBeGreaterThan(1);
    expect(down.grounded).toBe(true);
    expect(down.position.y).toBeLessThan(up.position.y);
  });
});

import { describe, expect, it } from "vitest";
import {
  ClientMessageSchema,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  ServerMessageSchema,
} from "./protocol";

const validJoin = {
  type: "join" as const,
  protocolVersion: PROTOCOL_VERSION,
  name: "arvind",
};

const validInput = {
  type: "input" as const,
  seq: 7,
  keys: { forward: true, back: false, left: false, right: true, jump: false },
  yaw: 1.2,
  pitch: -0.4,
  fire: null,
};

describe("decodeClientMessage", () => {
  it("round-trips an encoded message", () => {
    expect(decodeClientMessage(encodeMessage(validJoin))).toEqual(validJoin);
  });

  it("returns null for malformed JSON rather than throwing", () => {
    expect(decodeClientMessage("{ not json")).toBeNull();
    expect(decodeClientMessage("")).toBeNull();
  });

  it("returns null for an unknown message type", () => {
    expect(decodeClientMessage(JSON.stringify({ type: "shutdown" }))).toBeNull();
  });

  it("returns null when the payload is not an object", () => {
    expect(decodeClientMessage("42")).toBeNull();
    expect(decodeClientMessage("null")).toBeNull();
    expect(decodeClientMessage('"join"')).toBeNull();
  });

  it("rejects a mismatched protocol version", () => {
    const stale = { ...validJoin, protocolVersion: PROTOCOL_VERSION + 1 };
    expect(decodeClientMessage(JSON.stringify(stale))).toBeNull();
  });

  it("strips unknown extra fields instead of trusting them", () => {
    const decoded = decodeClientMessage(JSON.stringify({ ...validJoin, isAdmin: true }));
    expect(decoded).toEqual(validJoin);
    expect(decoded).not.toHaveProperty("isAdmin");
  });
});

describe("join name validation", () => {
  it("trims surrounding whitespace", () => {
    const decoded = decodeClientMessage(JSON.stringify({ ...validJoin, name: "  bob  " }));
    expect(decoded).toMatchObject({ name: "bob" });
  });

  it("rejects a name that is empty or whitespace only", () => {
    expect(decodeClientMessage(JSON.stringify({ ...validJoin, name: "" }))).toBeNull();
    expect(decodeClientMessage(JSON.stringify({ ...validJoin, name: "   " }))).toBeNull();
  });

  it("rejects control characters that would break the killfeed or log lines", () => {
    expect(decodeClientMessage(JSON.stringify({ ...validJoin, name: "bo\u0000b" }))).toBeNull();
    expect(decodeClientMessage(JSON.stringify({ ...validJoin, name: "line\nbreak" }))).toBeNull();
  });

  it("allows non-ascii names", () => {
    expect(decodeClientMessage(JSON.stringify({ ...validJoin, name: "अरविंद" }))).toMatchObject({
      name: "अरविंद",
    });
  });

  it("allows emoji built from a zero-width joiner", () => {
    for (const name of ["\u{1F9D1}\u200D\u{1F4BB}arvind", "\u{1F3F3}\uFE0F\u200D\u{1F308}bob"]) {
      expect(decodeClientMessage(JSON.stringify({ ...validJoin, name }))).toMatchObject({ name });
    }
  });

  it("still rejects a bidi override that would scramble the killfeed line", () => {
    const spoofed = { ...validJoin, name: "bob\u202Ednammoc" };
    expect(decodeClientMessage(JSON.stringify(spoofed))).toBeNull();
  });

  it("rejects a name longer than 24 characters", () => {
    expect(decodeClientMessage(JSON.stringify({ ...validJoin, name: "x".repeat(25) }))).toBeNull();
  });
});

describe("input validation", () => {
  it("accepts a well-formed input", () => {
    expect(decodeClientMessage(encodeMessage(validInput))).toEqual(validInput);
  });

  it("rejects a non-integer or negative sequence number", () => {
    expect(ClientMessageSchema.safeParse({ ...validInput, seq: 1.5 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...validInput, seq: -1 }).success).toBe(false);
  });

  it("rejects pitch outside the physically reachable range", () => {
    expect(ClientMessageSchema.safeParse({ ...validInput, pitch: Math.PI }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...validInput, pitch: -Math.PI }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...validInput, pitch: Math.PI / 2 }).success).toBe(true);
  });

  it("rejects non-finite look angles", () => {
    expect(ClientMessageSchema.safeParse({ ...validInput, yaw: Number.NaN }).success).toBe(false);
    expect(
      ClientMessageSchema.safeParse({ ...validInput, yaw: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
  });

  it("rejects a partial key set", () => {
    const { jump: _jump, ...partial } = validInput.keys;
    expect(ClientMessageSchema.safeParse({ ...validInput, keys: partial }).success).toBe(false);
  });

  it("accepts a frame that fired a weapon", () => {
    const shot = { ...validInput, fire: "primary" as const };
    expect(decodeClientMessage(encodeMessage(shot))).toEqual(shot);
  });

  it("rejects a weapon nobody carries", () => {
    expect(ClientMessageSchema.safeParse({ ...validInput, fire: "rocket" }).success).toBe(false);
  });

  it("rejects a frame with no trigger state at all", () => {
    // Required rather than defaulted on purpose: an M3 client that never sends the field
    // should fail at `join` and be told to reload, not join and silently never shoot.
    const { fire: _fire, ...triggerless } = validInput;
    expect(ClientMessageSchema.safeParse(triggerless).success).toBe(false);
  });

  it("has no separate fire message: a shot is something an input frame did", () => {
    expect(decodeClientMessage('{"type":"fire","seq":1,"slot":"primary"}')).toBeNull();
  });
});

describe("host-only messages", () => {
  it("accepts start, pause and close", () => {
    expect(decodeClientMessage('{"type":"start"}')).toEqual({ type: "start" });
    expect(decodeClientMessage('{"type":"pause","paused":true}')).toEqual({
      type: "pause",
      paused: true,
    });
    expect(decodeClientMessage('{"type":"close"}')).toEqual({ type: "close" });
  });

  it("rejects a kick without a target", () => {
    expect(decodeClientMessage('{"type":"kick"}')).toBeNull();
    expect(decodeClientMessage('{"type":"kick","targetId":""}')).toBeNull();
  });
});

describe("decodeServerMessage", () => {
  const player = {
    id: "p1",
    position: { x: 1, y: 2, z: 3 },
    yaw: 0,
    pitch: 0,
    velocityY: -4.5,
    grounded: false,
    health: 100,
    alive: true,
    spawnProtected: false,
    respawnAtTick: null as number | null,
    score: 2,
    deaths: 1,
  };

  const snapshot = {
    type: "snapshot" as const,
    tick: 120,
    ackSeq: 7,
    ammo: { primary: { magazine: 23, reserve: 120 }, secondary: { magazine: 12, reserve: 60 } },
    players: [player],
  };

  it("round-trips a snapshot", () => {
    expect(decodeServerMessage(encodeMessage(snapshot))).toEqual(snapshot);
  });

  it("rejects negative health", () => {
    const broken = {
      ...snapshot,
      players: [{ ...snapshot.players[0], health: -1 }],
    };
    expect(ServerMessageSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a snapshot player missing the state a replay needs", () => {
    // Dropping either field leaves the recipient unable to restore its own MovementState
    // before replaying, which mispredicts a jump or a fall in a way nothing else catches.
    for (const field of ["velocityY", "grounded"] as const) {
      const { [field]: _dropped, ...rest } = snapshot.players[0] ?? {};
      expect(ServerMessageSchema.safeParse({ ...snapshot, players: [rest] }).success).toBe(false);
    }
  });

  it("carries the recipient's own ammo, and nobody else's", () => {
    // It sits beside `ackSeq` rather than on every player: both are facts about the one
    // recipient this frame was built for.
    expect(decodeServerMessage(encodeMessage(snapshot))).toMatchObject({
      ammo: { primary: { magazine: 23 } },
    });
    // Null is reachable — a recipient who is not a player in this match — but absent is
    // not: a client reading `undefined` would show an empty gun.
    expect(ServerMessageSchema.safeParse({ ...snapshot, ammo: null }).success).toBe(true);
    const { ammo: _dropped, ...missing } = snapshot;
    expect(ServerMessageSchema.safeParse(missing).success).toBe(false);
  });

  it("carries the tick a dead player comes back at", () => {
    const dead = { ...player, health: 0, alive: false, respawnAtTick: 220 };
    expect(decodeServerMessage(encodeMessage({ ...snapshot, players: [dead] }))).toMatchObject({
      players: [{ respawnAtTick: 220 }],
    });

    // Absent is not the same as null: a client that read `undefined` as "alive" would
    // draw a corpse walking.
    const { respawnAtTick: _dropped, ...missing } = dead;
    expect(ServerMessageSchema.safeParse({ ...snapshot, players: [missing] }).success).toBe(false);
  });

  it("round-trips a matchStart carrying the recipient's own spawn", () => {
    const matchStart = {
      type: "matchStart" as const,
      tick: 0,
      tickRateHz: 20,
      killLimit: 30,
      timeLimitMs: 600_000,
      map: {
        name: "test",
        bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 3, z: 1 } },
        boxes: [],
        ramps: [],
        spawns: [{ position: { x: 0, y: 0, z: 0 }, yaw: 0 }],
      },
      spawn: { position: { x: 0, y: 0, z: 0 }, yaw: 1.5 },
    };
    expect(decodeServerMessage(encodeMessage(matchStart))).toEqual(matchStart);
    const { spawn: _none, ...withoutSpawn } = matchStart;
    expect(ServerMessageSchema.safeParse(withoutSpawn).success).toBe(false);
  });

  it("does not accept a client message", () => {
    expect(decodeServerMessage(encodeMessage(validJoin))).toBeNull();
  });

  it("rejects an unknown match end reason", () => {
    const bad = { type: "matchEnd", reason: "surrender", scores: [] };
    expect(decodeServerMessage(JSON.stringify(bad))).toBeNull();
  });

  it("round-trips a shot and the hit it landed", () => {
    const shot = { type: "shot" as const, shooterId: "p1", slot: "primary" as const };
    const hit = {
      type: "hit" as const,
      shooterId: "p1",
      targetId: "p2",
      slot: "primary" as const,
      damage: 22,
      remainingHealth: 78,
    };
    expect(decodeServerMessage(encodeMessage(shot))).toEqual(shot);
    expect(decodeServerMessage(encodeMessage(hit))).toEqual(hit);
  });

  it("accepts a death with no killer", () => {
    const death = {
      type: "death" as const,
      victimId: "p1",
      killerId: null,
      slot: null,
      respawnAtTick: 200,
    };
    expect(decodeServerMessage(encodeMessage(death))).toEqual(death);
  });
});

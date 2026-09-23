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
  const snapshot = {
    type: "snapshot" as const,
    tick: 120,
    ackSeq: 7,
    players: [
      {
        id: "p1",
        position: { x: 1, y: 2, z: 3 },
        yaw: 0,
        pitch: 0,
        health: 100,
        alive: true,
        spawnProtected: false,
        score: 2,
        deaths: 1,
      },
    ],
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

  it("does not accept a client message", () => {
    expect(decodeServerMessage(encodeMessage(validJoin))).toBeNull();
  });

  it("rejects an unknown match end reason", () => {
    const bad = { type: "matchEnd", reason: "surrender", scores: [] };
    expect(decodeServerMessage(JSON.stringify(bad))).toBeNull();
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

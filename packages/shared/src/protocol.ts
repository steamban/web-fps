import { z } from "zod";
import { Vec3Schema } from "./geometry";
import { MapDataSchema, SpawnPointSchema } from "./map";
import { WEAPON_SLOTS } from "./weapons";

/**
 * The wire protocol, defined once as Zod schemas with the TypeScript types inferred
 * from them. Compile-time types and runtime validation therefore cannot drift apart.
 *
 * Every inbound WebSocket frame is `unknown` until it has been through these schemas —
 * see `decodeClientMessage` / `decodeServerMessage`.
 */

/** Bumped on any incompatible wire change; mismatched clients are rejected at `join`. */
export const PROTOCOL_VERSION = 4 as const;

/** Path the WebSocket endpoint is mounted at. Both sides read it from here so it cannot drift. */
export const WS_PATH = "/ws";

export const PlayerIdSchema = z.string().min(1).max(64);
export type PlayerId = z.infer<typeof PlayerIdSchema>;

/**
 * Names are rendered in the killfeed and scoreboard, so control characters (which would
 * break the layout or smuggle newlines into logs) and bidi overrides (which would let a
 * name scramble the line around it) are rejected at the wire boundary.
 *
 * `\p{C}` covers all of that, but it also covers U+200D ZERO WIDTH JOINER — the character
 * every family and profession emoji is built from — so that one is allowed back in.
 */
export const PlayerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .regex(/^(?:[^\p{C}]|\u200D)+$/u, { message: "name must not contain control characters" });

export const WeaponSlotSchema = z.enum(WEAPON_SLOTS);

/** Vertical look is physically bounded; horizontal look wraps and is normalised server-side. */
const PitchSchema = z
  .number()
  .min(-Math.PI / 2)
  .max(Math.PI / 2);
const YawSchema = z.number();

export const MATCH_PHASES = ["waiting", "inProgress", "paused", "ended"] as const;
export const MatchPhaseSchema = z.enum(MATCH_PHASES);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------

export const InputKeysSchema = z.object({
  forward: z.boolean(),
  back: z.boolean(),
  left: z.boolean(),
  right: z.boolean(),
  jump: z.boolean(),
});
export type InputKeys = z.infer<typeof InputKeysSchema>;

export const JoinMessageSchema = z.object({
  type: z.literal("join"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  name: PlayerNameSchema,
});

/**
 * Sent once per client tick. `seq` increments monotonically and is echoed back in
 * `snapshot.ackSeq` so the client knows which predicted inputs to replay. The schema
 * cannot police "monotonic" — a frame carrying 5, 5, 3 is well-formed — so the server
 * drops anything not above what it has already simulated for that player.
 *
 * `fire` names the weapon this frame pulled the trigger on, or null for a frame that did
 * not. A shot is something an input frame did rather than a message of its own: the server
 * resolves it from where this frame's movement leaves the shooter, along this frame's yaw
 * and pitch, so the shot and the aim it was taken with cannot come apart. A frame the
 * server's monotonic guard drops takes its shot with it, which is what stops a replayed
 * frame firing twice.
 */
export const InputMessageSchema = z.object({
  type: z.literal("input"),
  seq: z.number().int().nonnegative(),
  keys: InputKeysSchema,
  yaw: YawSchema,
  pitch: PitchSchema,
  fire: WeaponSlotSchema.nullable(),
});

export const StartMessageSchema = z.object({ type: z.literal("start") });
export const PauseMessageSchema = z.object({ type: z.literal("pause"), paused: z.boolean() });
export const CloseMessageSchema = z.object({ type: z.literal("close") });
export const KickMessageSchema = z.object({
  type: z.literal("kick"),
  targetId: PlayerIdSchema,
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  JoinMessageSchema,
  InputMessageSchema,
  StartMessageSchema,
  PauseMessageSchema,
  CloseMessageSchema,
  KickMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------

export const LobbyPlayerSchema = z.object({
  id: PlayerIdSchema,
  name: PlayerNameSchema,
  isHost: z.boolean(),
});
export type LobbyPlayer = z.infer<typeof LobbyPlayerSchema>;

export const LobbyStateMessageSchema = z.object({
  type: z.literal("lobbyState"),
  phase: MatchPhaseSchema,
  /** Null only in the moment between the host leaving and a new one being promoted. */
  hostId: PlayerIdSchema.nullable(),
  selfId: PlayerIdSchema,
  minPlayers: z.number().int().positive(),
  maxPlayers: z.number().int().positive(),
  players: z.array(LobbyPlayerSchema),
});

/**
 * Sent per recipient, like `lobbyState`: `spawn` is the one the server seated *this*
 * player at. Without it the client cannot face the way the map spawns it, and its first
 * input would overwrite the server's spawn yaw before anything was ever rendered.
 */
export const MatchStartMessageSchema = z.object({
  type: z.literal("matchStart"),
  tick: z.number().int().nonnegative(),
  tickRateHz: z.number().int().positive(),
  killLimit: z.number().int().positive(),
  timeLimitMs: z.number().int().positive(),
  map: MapDataSchema,
  spawn: SpawnPointSchema,
});

export const SnapshotPlayerSchema = z.object({
  id: PlayerIdSchema,
  position: Vec3Schema,
  yaw: YawSchema,
  pitch: PitchSchema,
  /**
   * The rest of what a movement step carries between ticks. Horizontal velocity is
   * re-derived from the keys every step, so `position`, `velocityY` and `grounded` are
   * exactly what the recipient needs to restore its own state before replaying the
   * inputs the server has not acknowledged yet.
   */
  velocityY: z.number(),
  grounded: z.boolean(),
  health: z.number().int().nonnegative(),
  alive: z.boolean(),
  spawnProtected: z.boolean(),
  /**
   * Tick this player comes back at, or null while they are alive. The snapshot already
   * carries the tick it was taken at, so a client subtracts the two for the countdown on
   * screen — no separate `death` frame has to arrive, or arrive in order, for the number
   * to be right.
   */
  respawnAtTick: z.number().int().nonnegative().nullable(),
  score: z.number().int().nonnegative(),
  deaths: z.number().int().nonnegative(),
});
export type SnapshotPlayer = z.infer<typeof SnapshotPlayerSchema>;

export const SnapshotMessageSchema = z.object({
  type: z.literal("snapshot"),
  tick: z.number().int().nonnegative(),
  /**
   * Last `input.seq` from this recipient folded into *this* snapshot's state; 0 before
   * the server has simulated any of theirs, which the server's monotonic guard makes
   * unambiguous. An ack read anywhere but inside the step would name an input the
   * positions do not yet include.
   */
  ackSeq: z.number().int().nonnegative(),
  players: z.array(SnapshotPlayerSchema),
});

/**
 * Somebody pulled a trigger. It carries no ray and no origin: whoever receives it already
 * has the shooter's position in the snapshot for the same tick, and the only thing it is
 * for is making a shot audible to everyone who did not fire it — a miss changes no
 * snapshot field, so without this frame half of a firefight is silent.
 */
export const ShotMessageSchema = z.object({
  type: z.literal("shot"),
  shooterId: PlayerIdSchema,
  slot: WeaponSlotSchema,
});

/**
 * One shot that cost one player health, sent to the shooter alone: it is what a hit
 * marker is drawn from, and with two people shooting at one target the snapshot's health
 * drop says nothing about whose bullet did it.
 *
 * `remainingHealth` is what the target has left after *the whole tick* — shots are
 * resolved against a frozen world, so there is no per-shot order to subtract in, and two
 * shooters landing on one target this tick are both told the same number.
 */
export const HitMessageSchema = z.object({
  type: z.literal("hit"),
  shooterId: PlayerIdSchema,
  targetId: PlayerIdSchema,
  slot: WeaponSlotSchema,
  damage: z.number().int().nonnegative(),
  remainingHealth: z.number().int().nonnegative(),
});

export const DeathMessageSchema = z.object({
  type: z.literal("death"),
  victimId: PlayerIdSchema,
  /** Null for a non-combat death (out of bounds, disconnect cleanup). */
  killerId: PlayerIdSchema.nullable(),
  slot: WeaponSlotSchema.nullable(),
  respawnAtTick: z.number().int().nonnegative(),
});

export const MATCH_END_REASONS = ["killLimit", "timeLimit", "closed"] as const;
export const MatchEndReasonSchema = z.enum(MATCH_END_REASONS);
export type MatchEndReason = z.infer<typeof MatchEndReasonSchema>;

export const ScoreEntrySchema = z.object({
  id: PlayerIdSchema,
  name: PlayerNameSchema,
  score: z.number().int().nonnegative(),
  deaths: z.number().int().nonnegative(),
});
export type ScoreEntry = z.infer<typeof ScoreEntrySchema>;

export const MatchEndMessageSchema = z.object({
  type: z.literal("matchEnd"),
  reason: MatchEndReasonSchema,
  scores: z.array(ScoreEntrySchema),
});

export const KICK_REASONS = [
  "host",
  "lobbyFull",
  "matchInProgress",
  "lobbyClosed",
  "protocolMismatch",
  "invalidMessage",
] as const;
export const KickReasonSchema = z.enum(KICK_REASONS);
export type KickReason = z.infer<typeof KickReasonSchema>;

export const KickedMessageSchema = z.object({
  type: z.literal("kicked"),
  reason: KickReasonSchema,
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  LobbyStateMessageSchema,
  MatchStartMessageSchema,
  SnapshotMessageSchema,
  ShotMessageSchema,
  HitMessageSchema,
  DeathMessageSchema,
  MatchEndMessageSchema,
  KickedMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------------------
// wire decoding
// ---------------------------------------------------------------------------

function decode<T extends z.ZodType>(schema: T, data: string): z.infer<T> | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : null;
}

/** Returns `null` for anything the server must not trust: bad JSON or a schema mismatch. */
export function decodeClientMessage(data: string): ClientMessage | null {
  return decode(ClientMessageSchema, data);
}

/** Returns `null` if the server sent something this client build cannot understand. */
export function decodeServerMessage(data: string): ServerMessage | null {
  return decode(ServerMessageSchema, data);
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

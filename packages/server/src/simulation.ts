import {
  type InputKeys,
  type MapData,
  type MovementState,
  type PlayerId,
  type ServerMessage,
  type SnapshotPlayer,
  spawnState,
  stepMovement,
  wrapAngle,
} from "@web-fps/shared";
import type { Config } from "./config";

/**
 * The authoritative simulation, as pure functions: state and inputs in, state out. No
 * clock, no sockets, no `Date.now()` — `net.ts` owns all of that and calls `simulate` on a
 * fixed interval. That split is what lets every case here be a plain function call, the
 * same way `lobby.ts` is tested without a socket.
 *
 * The movement itself is `stepMovement` from `shared`, called with the same arguments the
 * client's prediction calls it with. Prediction only works while that stays true: the
 * server holds the fold over players and the input bookkeeping, and nothing else.
 */

export interface PlayerInput {
  readonly playerId: PlayerId;
  readonly seq: number;
  readonly keys: InputKeys;
  readonly yaw: number;
  readonly pitch: number;
}

export interface PlayerSimState {
  readonly id: PlayerId;
  readonly movement: MovementState;
  readonly yaw: number;
  readonly pitch: number;
  /** Highest `input.seq` from this player folded into `movement`; 0 before any has been. */
  readonly ackSeq: number;
}

export interface GameState {
  readonly tick: number;
  readonly map: MapData;
  readonly players: readonly PlayerSimState[];
}

const NO_KEYS: InputKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
};

/**
 * Seats everyone at a spawn of their own, once. The assignment is pinned into the state
 * rather than recomputed from a position in the member list, because that list shifts the
 * moment somebody leaves — and everyone still playing would teleport with it.
 */
export function createGame(map: MapData, playerIds: readonly PlayerId[]): GameState {
  return {
    tick: 0,
    map,
    players: playerIds.map((id, index) => {
      const spawn = map.spawns[index % map.spawns.length];
      if (!spawn) throw new Error(`map ${map.name} has no spawn points`);
      return { id, movement: spawnState(spawn), yaw: spawn.yaw, pitch: 0, ackSeq: 0 };
    }),
  };
}

/**
 * One tick. Every input queued for a player since the last tick is applied in order, each
 * as its own full step, so the server walks exactly the sequence the client predicted —
 * taking only the newest would leave it permanently a step behind an input the client has
 * already dropped at ack, which is the rubber-band this whole arrangement exists to avoid.
 */
export function simulate(
  state: GameState,
  inputs: readonly PlayerInput[],
  dtMs: number,
): GameState {
  return {
    ...state,
    tick: state.tick + 1,
    players: state.players.map((player) => {
      let next = player;

      for (const input of inputs) {
        if (input.playerId !== player.id) continue;
        // A resent or reordered sequence number is not simulated twice. This is also what
        // keeps `ackSeq: 0` meaning "nothing acknowledged yet" and nothing else.
        if (input.seq <= next.ackSeq) continue;

        // Yaw is unbounded on the wire; folded here, at the boundary, so that no consumer
        // downstream has to survive a value that overflows the difference between two.
        const yaw = wrapAngle(input.yaw);
        next = {
          id: next.id,
          movement: stepMovement(next.movement, input.keys, yaw, dtMs, state.map),
          yaw,
          pitch: input.pitch,
          ackSeq: input.seq,
        };
      }

      // Gravity only advances inside a step, so a player whose frame was late or dropped
      // still has to fall. Their keys are released for that tick rather than repeated: a
      // repeat would walk them into geometry the server never heard them ask for.
      if (next === player) {
        const movement = stepMovement(player.movement, NO_KEYS, player.yaw, dtMs, state.map);
        next = { ...player, movement };
      }
      return next;
    }),
  };
}

/**
 * Drops everyone who has left the lobby. Filters only — `join` is refused once a match is
 * running, so a member appearing mid-match is a bug, and an inserted player would have no
 * spawn to appear at.
 */
export function retainPlayers(state: GameState, ids: ReadonlySet<PlayerId>): GameState {
  const players = state.players.filter((player) => ids.has(player.id));
  return players.length === state.players.length ? state : { ...state, players };
}

const snapshotOf = (player: PlayerSimState): SnapshotPlayer => ({
  id: player.id,
  position: player.movement.position,
  yaw: player.yaw,
  pitch: player.pitch,
  velocityY: player.movement.velocity.y,
  grounded: player.movement.grounded,
  // Constants for now: nothing in M3 can damage anyone (M4) or score (M5). Held here
  // rather than as untouched fields on GameState, which would read as simulated.
  health: 100,
  alive: true,
  spawnProtected: false,
  score: 0,
  deaths: 0,
});

/**
 * The `snapshot` frame as one recipient should see it — per recipient because `ackSeq`
 * names *their* last simulated input. The same split as `lobbyStateFor`.
 */
export function snapshotFor(state: GameState, recipientId: PlayerId): ServerMessage {
  const recipient = state.players.find((player) => player.id === recipientId);
  return {
    type: "snapshot",
    tick: state.tick,
    ackSeq: recipient?.ackSeq ?? 0,
    players: state.players.map(snapshotOf),
  };
}

/** The `matchStart` frame for one player, carrying the spawn they were actually seated at. */
export function matchStartFor(
  state: GameState,
  config: Config,
  player: PlayerSimState,
): ServerMessage {
  return {
    type: "matchStart",
    tick: state.tick,
    tickRateHz: config.tickRateHz,
    killLimit: config.killLimit,
    timeLimitMs: config.timeLimitMs,
    map: state.map,
    spawn: { position: player.movement.position, yaw: player.yaw },
  };
}

import {
  aimDirection,
  eyePosition,
  type InputKeys,
  MAX_HEALTH,
  type MapData,
  type MovementState,
  type PlayerId,
  type ServerMessage,
  type SnapshotPlayer,
  type SpawnPoint,
  spawnState,
  stepMovement,
  type Vec3,
  type WeaponSlot,
  wrapAngle,
} from "@web-fps/shared";
import { resolveShots, type Shot } from "./combat";
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
  /** The weapon this frame fired, or null for a frame that held its fire. */
  readonly fire: WeaponSlot | null;
}

export interface PlayerSimState {
  readonly id: PlayerId;
  readonly movement: MovementState;
  readonly yaw: number;
  readonly pitch: number;
  /** Highest `input.seq` from this player folded into `movement`; 0 before any has been. */
  readonly ackSeq: number;
  /** 0 to `MAX_HEALTH`, always whole. Dead is `health === 0`, and `alive` is derived from
   *  it rather than stored: two fields for one fact disagree as soon as one write site
   *  forgets the other. */
  readonly health: number;
  /** Kills landed and deaths taken, counted where a kill happens. M5 reads them for the
   *  kill limit and the scoreboard rather than recounting them from anywhere else. */
  readonly score: number;
  readonly deaths: number;
  /** Tick this player comes back at, or null while they are alive. Counted from the tick
   *  the killing blow landed on, so a respawn is the configured delay and not a tick more. */
  readonly respawnAtTick: number | null;
  /** Earliest tick this player may fire again. One clock for all three weapons, so
   *  switching slots cannot be used to shoot faster than either of them allows. */
  readonly nextFireTick: number;
}

/**
 * What ends a round and what happens in between, counted in the only unit the simulation
 * has: ticks. Pinned into the state at match start for the same reason the spawns are —
 * a round is played out under the rules it began under, and nothing downstream needs a
 * `Config` to know whether it is over.
 */
export interface RoundRules {
  readonly killLimit: number;
  /** Ticks the match may run for. Only a stepped tick counts, so a pause burns no clock. */
  readonly timeLimitTicks: number;
  readonly respawnTicks: number;
  readonly protectionTicks: number;
}

/**
 * The configured milliseconds, quantised to the tick the simulation actually steps in.
 *
 * Rounded up, like `fireCooldownTicks`: a limit is a floor on what was asked for, so 5 s
 * of protection at 3 Hz is 5.33 s rather than 4.67 s. The time limit is floored at one
 * tick as well — a match that ends before it has stepped has no state to end from, and
 * `matchStart.timeLimitMs` is a positive integer on the wire.
 */
export function roundRules(config: Config): RoundRules {
  const ticks = (ms: number): number => Math.ceil(ms / config.tickIntervalMs);
  return {
    killLimit: config.killLimit,
    timeLimitTicks: Math.max(1, ticks(config.timeLimitMs)),
    respawnTicks: ticks(config.respawnMs),
    protectionTicks: ticks(config.spawnProtectionMs),
  };
}

export interface GameState {
  readonly tick: number;
  readonly map: MapData;
  readonly rules: RoundRules;
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
export function createGame(
  map: MapData,
  playerIds: readonly PlayerId[],
  rules: RoundRules,
): GameState {
  return {
    tick: 0,
    map,
    rules,
    players: playerIds.map((id, index) => {
      const spawn = map.spawns[index % map.spawns.length];
      if (!spawn) throw new Error(`map ${map.name} has no spawn points`);
      return {
        id,
        movement: spawnState(spawn),
        yaw: spawn.yaw,
        pitch: 0,
        ackSeq: 0,
        health: MAX_HEALTH,
        score: 0,
        deaths: 0,
        respawnAtTick: null,
        nextFireTick: 0,
      };
    }),
  };
}

/**
 * One tick. Every input queued for a player since the last tick is applied in order, each
 * as its own full step, so the server walks exactly the sequence the client predicted —
 * taking only the newest would leave it permanently a step behind an input the client has
 * already dropped at ack, which is the rubber-band this whole arrangement exists to avoid.
 *
 * Movement first, then the shots taken on those frames: a shot leaves from where this tick
 * left the shooter and arrives where it left everyone else. Resolving it inside the fold
 * would aim a tick behind — over half a player's width at the default speed — and could
 * not write damage to anybody else in the first place.
 */
export function simulate(
  state: GameState,
  inputs: readonly PlayerInput[],
  dtMs: number,
): GameState {
  // One shot per player per tick: no weapon's cooldown is shorter than a tick, so a burst
  // of frames could only ever land one of them anyway, and the last frame naming one wins.
  // The ray is captured here, from the frame that fired it — a later frame in the same tick
  // has a different aim, and dragging the bullet onto it would hit what the player had not
  // aimed at yet.
  const requested = new Map<PlayerId, Shot>();

  const moved: GameState = {
    ...state,
    tick: state.tick + 1,
    players: state.players.map((player) => {
      // A corpse neither walks nor falls, but its frames are still acknowledged: its client
      // holds every unacknowledged input until the server names one, and would otherwise
      // replay the same buffer for as long as the body lies there.
      if (player.health === 0) {
        let ackSeq = player.ackSeq;
        for (const input of inputs) {
          if (input.playerId === player.id && input.seq > ackSeq) ackSeq = input.seq;
        }
        return ackSeq === player.ackSeq ? player : { ...player, ackSeq };
      }

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
          ...next,
          movement: stepMovement(next.movement, input.keys, yaw, dtMs, state.map),
          yaw,
          pitch: input.pitch,
          ackSeq: input.seq,
        };

        if (input.fire !== null) {
          requested.set(player.id, {
            slot: input.fire,
            origin: eyePosition(next.movement.position),
            direction: aimDirection(yaw, input.pitch),
          });
        }
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

  return respawnDue(resolveShots(moved, requested, dtMs));
}

/**
 * Where to put somebody who is coming back: the spawn furthest from the nearest player
 * who could shoot them for it.
 *
 * Deterministic — no randomness anywhere in the simulation, so a replay of the same
 * inputs is the same match — and it costs a pass over eight spawns. The alternative is
 * the spawn they were seated at, which in a thirty-kill deathmatch on one small map is an
 * invitation to stand on it. The ceiling: it knows where people are, not where they are
 * looking, so it can still hand somebody a spawn with a rifle pointed at it from across
 * the map.
 */
function spawnFurthestFromDanger(state: GameState, playerId: PlayerId): SpawnPoint {
  const threats = state.players.filter((player) => player.id !== playerId && player.health > 0);

  let best = state.map.spawns[0];
  if (!best) throw new Error(`map ${state.map.name} has no spawn points`);
  let bestDistance = Number.NEGATIVE_INFINITY;

  for (const spawn of state.map.spawns) {
    // Nothing to keep away from on an empty map: the first spawn wins, as it does on a tie.
    let nearest = Number.POSITIVE_INFINITY;
    for (const threat of threats) {
      nearest = Math.min(nearest, squaredDistance(spawn.position, threat.movement.position));
    }
    if (nearest > bestDistance) {
      best = spawn;
      bestDistance = nearest;
    }
  }
  return best;
}

const squaredDistance = (a: Vec3, b: Vec3): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

/**
 * Brings back everyone whose countdown has run out, one at a time: a player already
 * returned this tick is somebody the next one keeps away from, which is what stops two
 * players who died together landing on the same spawn.
 */
function respawnDue(state: GameState): GameState {
  const isDue = (player: PlayerSimState): boolean =>
    player.respawnAtTick !== null && state.tick >= player.respawnAtTick;
  if (!state.players.some(isDue)) return state;

  const players = [...state.players];
  for (const [index, player] of players.entries()) {
    if (!isDue(player)) continue;
    const spawn = spawnFurthestFromDanger({ ...state, players }, player.id);
    players[index] = {
      ...player,
      movement: spawnState(spawn),
      yaw: spawn.yaw,
      pitch: 0,
      health: MAX_HEALTH,
      respawnAtTick: null,
    };
  }
  return { ...state, players };
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
  health: player.health,
  alive: player.health > 0,
  score: player.score,
  deaths: player.deaths,
  respawnAtTick: player.respawnAtTick,
  // Still a constant: nothing protects a spawn until M5 adds the timer that expires.
  spawnProtected: false,
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
    killLimit: state.rules.killLimit,
    // The quantised limit, not the configured one: it is what the match is actually run
    // against, and a client counting down to a different number would be wrong on screen.
    timeLimitMs: Math.round(state.rules.timeLimitTicks * config.tickIntervalMs),
    map: state.map,
    spawn: { position: player.movement.position, yaw: player.yaw },
  };
}

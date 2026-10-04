import {
  type Ammo,
  aimDirection,
  compareScores,
  eyePosition,
  type InputKeys,
  LOADOUT,
  MAX_HEALTH,
  type MapData,
  type MatchEndReason,
  type MovementState,
  type PlayerId,
  type ScoreEntry,
  type ServerMessage,
  type SnapshotPlayer,
  type SpawnPoint,
  spawnState,
  stepMovement,
  usesAmmo,
  type Vec3,
  WEAPON_SLOTS,
  type WeaponSlot,
  wrapAngle,
} from "@web-fps/shared";
import { reloadTicks, resolveShots, type Shot } from "./combat";
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
  /** The weapon this frame asked to reload, or null. Refused unless `startReloads` allows it. */
  readonly reload: WeaponSlot | null;
}

/**
 * One slot's ammunition. `reloadingUntilTick` is the tick the fresh magazine goes in,
 * and it is per slot while `nextFireTick` is per player: the fire cooldown is shared so
 * that switching weapons cannot be used to shoot faster than either of them allows (M4),
 * but a reload is a property of the magazine, and sharing it would mean emptying one gun
 * locks the other two for as long as the reload takes.
 */
export interface SlotAmmo {
  readonly magazine: number;
  readonly reserve: number;
  readonly reloadingUntilTick: number;
}

const loadedSlot = (slot: WeaponSlot): SlotAmmo => ({
  magazine: LOADOUT[slot].magazineSize ?? 0,
  reserve: LOADOUT[slot].reserveAmmo,
  reloadingUntilTick: 0,
});

/** A full loadout, as issued at a spawn. Melee gets an entry it never reads: keying by
 *  the whole slot union is what lets every read of it go unguarded. */
export const fullAmmo = (): Readonly<Record<WeaponSlot, SlotAmmo>> => ({
  primary: loadedSlot("primary"),
  secondary: loadedSlot("secondary"),
  melee: loadedSlot("melee"),
});

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
  /** Tick this player's spawn protection runs out; 0 once it has been given up or never
   *  granted. Compared against the tick being played, so `spawnProtected` on the wire is
   *  derived from it rather than stored twice. */
  readonly protectedUntilTick: number;
  /** Tick this player comes back at, or null while they are alive. Counted from the tick
   *  the killing blow landed on, so a respawn is the configured delay and not a tick more. */
  readonly respawnAtTick: number | null;
  /** Earliest tick this player may fire again. One clock for all three weapons, so
   *  switching slots cannot be used to shoot faster than either of them allows. */
  readonly nextFireTick: number;
  /** What is left in each magazine and each reserve. Reset at a spawn, like health. */
  readonly ammo: Readonly<Record<WeaponSlot, SlotAmmo>>;
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
 * Rounded up, like `fireCooldownTicks`: a limit is a floor on what was asked for, so 75 ms
 * of protection at the default 20 Hz is 100 ms rather than 50. The time limit is floored at one
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

/**
 * What a tick produced: the state it left behind, and the frames describing what happened
 * inside it that no snapshot can carry — who shot, who hit whom, who died to whom.
 *
 * The shape `lobby.ts` returns, with one deliberate difference in the word: a lobby
 * `effect` is an instruction to the transport, an `event` here is a fact. `simulate` never
 * sends anything (PLAN.md "Side effects live only in the shell"); it hands `net.ts` frames
 * and `net.ts` decides who they go to. They are `ServerMessage`s rather than a private
 * event union because there is no consumer that wants anything else — a parallel type with
 * a mapper would be one abstraction with one implementation.
 */
export interface SimResult {
  readonly state: GameState;
  readonly events: readonly ServerMessage[];
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
        // A spawn is a spawn: the opening seconds of a match are protected for the same
        // reason a respawn is, and the alternative is a scramble the fastest click wins.
        protectedUntilTick: rules.protectionTicks,
        respawnAtTick: null,
        nextFireTick: 0,
        ammo: fullAmmo(),
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
): SimResult {
  // One shot per player per tick: no weapon's cooldown is shorter than a tick, so a burst
  // of frames could only ever land one of them anyway, and the last frame naming one wins.
  // The ray is captured here, from the frame that fired it — a later frame in the same tick
  // has a different aim, and dragging the bullet onto it would hit what the player had not
  // aimed at yet.
  const requested = new Map<PlayerId, Shot>();
  // Likewise one reload per player per tick, and for the simpler reason that the second
  // would be refused as "already reloading" the moment the first took.
  const reloads = new Map<PlayerId, WeaponSlot>();

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
        if (input.reload !== null) reloads.set(player.id, input.reload);
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

  // Before the shots, so that a magazine whose reload finishes on this tick can be fired
  // on it — refilling afterwards would make every reload one tick longer than the clock
  // the shot that emptied it charged.
  const resolved = resolveShots(reloadDue(moved), requested, dtMs);
  // After the shots: a frame that both fires and reloads spends the round first, and one
  // whose shot emptied the magazine finds the clock already running and asks for nothing.
  const reloading = startReloads(resolved.state, reloads, dtMs);
  // A respawn is already on the wire as `respawnAtTick` counting down on the snapshot, so
  // it produces no event of its own — see the M5 design log.
  return { state: respawnDue(reloading), events: resolved.events };
}

/**
 * Puts the rounds in every slot whose reload has come due: a clock pending, something left
 * in reserve, and past the tick that clock named.
 *
 * It refills every due slot rather than the one being carried, because the server has no
 * idea which that is — the weapon rides each input frame precisely so that it needs no
 * equipped state to keep in step (M4). It costs nothing: a slot only goes dry by being
 * fired, and a partial reserve is taken as far as it goes and then the slot is dead.
 */
function reloadDue(state: GameState): GameState {
  const isDue = (ammo: SlotAmmo, slot: WeaponSlot): boolean =>
    usesAmmo(slot) &&
    // A pending clock, rather than an empty magazine, is now what a reload *is*: a manual
    // one runs on a partial magazine, which is indistinguishable from one standing still.
    ammo.reloadingUntilTick > 0 &&
    ammo.reserve > 0 &&
    state.tick >= ammo.reloadingUntilTick;

  const due = (player: PlayerSimState): boolean =>
    WEAPON_SLOTS.some((slot) => isDue(player.ammo[slot], slot));
  if (!state.players.some(due)) return state;

  return {
    ...state,
    players: state.players.map((player) => {
      if (!due(player)) return player;
      const ammo = { ...player.ammo };
      for (const slot of WEAPON_SLOTS) {
        const held = ammo[slot];
        if (!isDue(held, slot)) continue;
        // Topped up, not replaced: a manual reload keeps what is already in the magazine
        // and takes the difference out of the reserve. An emptied one has nothing to keep,
        // so this is the same arithmetic the automatic reload always did.
        const filled = Math.min(LOADOUT[slot].magazineSize ?? 0, held.magazine + held.reserve);
        ammo[slot] = {
          magazine: filled,
          reserve: held.reserve - (filled - held.magazine),
          reloadingUntilTick: 0,
        };
      }
      return { ...player, ammo };
    }),
  };
}

/**
 * Starts the reloads this tick asked for. Refused when the magazine is already full, when
 * there is nothing in reserve to put in it, when a reload is already running, or when the
 * weapon draws from no ammunition at all — a client can send `reload` every frame and get
 * one reload, not a shorter one.
 *
 * The clock is all this writes. `reloadDue` is what moves the rounds, on this tick's own
 * pass for an automatic reload and a later one for this, so there is exactly one place a
 * magazine is ever filled.
 */
function startReloads(
  state: GameState,
  reloads: ReadonlyMap<PlayerId, WeaponSlot>,
  dtMs: number,
): GameState {
  if (reloads.size === 0) return state;

  return {
    ...state,
    players: state.players.map((player) => {
      const slot = reloads.get(player.id);
      if (slot === undefined || !usesAmmo(slot)) return player;

      const held = player.ammo[slot];
      const full = held.magazine >= (LOADOUT[slot].magazineSize ?? 0);
      if (full || held.reserve === 0 || held.reloadingUntilTick > 0) return player;

      return {
        ...player,
        ammo: {
          ...player.ammo,
          [slot]: { ...held, reloadingUntilTick: state.tick + reloadTicks(slot, dtMs) },
        },
      };
    }),
  };
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
      protectedUntilTick: state.tick + state.rules.protectionTicks,
      respawnAtTick: null,
      // A spawn is a spawn: there are no pickups on this map, so anybody who came back
      // with what they had left would eventually be stuck holding the knife.
      ammo: fullAmmo(),
    };
  }
  return { ...state, players };
}

/**
 * Why this match is over, or null while it is not. Read after a tick by the shell that
 * owns the clock — the rules it compares against were pinned at kickoff, so this is a
 * question about a state and nothing else.
 *
 * The kill limit is asked first: if the tick that took somebody to it is also the tick
 * the clock ran out on, "somebody got there" is the truer answer of the two, and it is
 * the one the scoreboard is about to show.
 */
export function matchOutcome(state: GameState): MatchEndReason | null {
  if (state.players.some((player) => player.score >= state.rules.killLimit)) return "killLimit";
  if (state.tick >= state.rules.timeLimitTicks) return "timeLimit";
  return null;
}

/**
 * The final scoreboard, best first. Sorted here rather than on arrival so that every
 * client shows the same order and the tie-break is decided once: most kills, then fewest
 * deaths, then by id — which is arbitrary but total, and a stable order is worth more
 * than a fair one between two players with identical lines.
 *
 * Anyone the lobby no longer has a name for has left mid-match and is left off.
 */
export function matchEndMessage(
  state: GameState,
  reason: MatchEndReason,
  names: ReadonlyMap<PlayerId, string>,
): ServerMessage {
  const scores: ScoreEntry[] = state.players.flatMap((player) => {
    const name = names.get(player.id);
    return name === undefined
      ? []
      : [{ id: player.id, name, score: player.score, deaths: player.deaths }];
  });
  scores.sort(compareScores);
  return { type: "matchEnd", reason, scores };
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

const snapshotOf = (player: PlayerSimState, tick: number): SnapshotPlayer => ({
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
  spawnProtected: isSpawnProtected(player, tick),
});

/**
 * What of a slot's ammunition the wire carries. `reloadingUntilTick` is 0 for "nothing
 * pending" inside the simulation and null on the wire, because a tick of 0 is a real tick
 * and the recipient compares it against the snapshot's own.
 */
const rounds = (ammo: SlotAmmo): Ammo => ({
  magazine: ammo.magazine,
  reserve: ammo.reserve,
  readyAtTick: ammo.reloadingUntilTick === 0 ? null : ammo.reloadingUntilTick,
});

/** Derived, never stored, for the reason `alive` is: one fact, one place it is decided. */
export const isSpawnProtected = (player: PlayerSimState, tick: number): boolean =>
  tick < player.protectedUntilTick;

/**
 * Every player as the wire sees them, once per tick — shared across every recipient's
 * `snapshotFor` rather than rebuilt per recipient, since it does not vary by who is asking.
 */
export const snapshotPlayers = (state: GameState): SnapshotPlayer[] =>
  state.players.map((player) => snapshotOf(player, state.tick));

/**
 * The `snapshot` frame as one recipient should see it — per recipient because `ackSeq`
 * names *their* last simulated input. The same split as `lobbyStateFor`.
 */
export function snapshotFor(
  state: GameState,
  recipientId: PlayerId,
  players: SnapshotPlayer[],
): ServerMessage {
  const recipient = state.players.find((player) => player.id === recipientId);
  return {
    type: "snapshot",
    tick: state.tick,
    ackSeq: recipient?.ackSeq ?? 0,
    // Theirs alone, like the ack above it, and null in the same case: somebody who is not
    // a player in this match.
    ammo:
      recipient === undefined
        ? null
        : {
            primary: rounds(recipient.ammo.primary),
            secondary: rounds(recipient.ammo.secondary),
          },
    players,
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

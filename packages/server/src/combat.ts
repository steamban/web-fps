import {
  LOADOUT,
  type PlayerId,
  playerBox,
  rayHitsAabb,
  rayHitsMap,
  type ServerMessage,
  usesAmmo,
  type Vec3,
  type WeaponSlot,
} from "@web-fps/shared";
import {
  type GameState,
  isSpawnProtected,
  type PlayerSimState,
  type SimResult,
  type SlotAmmo,
} from "./simulation";

/**
 * Hit resolution: who a shot reaches and what that costs them. Pure, like the rest of the
 * simulation — a state and the shots asked for, a state back — which is what lets the
 * milestone's own test (PLAN.md M4) be a ray against known positions with no socket in it.
 *
 * The rules live here rather than in `shared` for the reason M3 recorded for `simulate`:
 * the client never decides a hit. What is shared is the geometry both sides already agree
 * on — the hitbox, the eye, the aim, and the ray against the map.
 */

/**
 * Ticks a weapon is unavailable for after it fires.
 *
 * Rounded up, because the simulation only exists at tick boundaries: the SMG's 90 ms is
 * 100 ms at the default 20 Hz. Floored at one tick, which every weapon in the table
 * already exceeds at every supported rate, so a player can never fire twice in one tick
 * however many input frames they fit into it.
 */
export function fireCooldownTicks(slot: WeaponSlot, dtMs: number): number {
  return Math.max(1, Math.ceil(LOADOUT[slot].fireIntervalMs / dtMs));
}

/**
 * Ticks a magazine takes to refill, rounded up and floored at one exactly like
 * `fireCooldownTicks` — the simulation only exists at tick boundaries, so a reload is a
 * floor on what the table asked for rather than a number the tick rate may shave.
 */
export function reloadTicks(slot: WeaponSlot, dtMs: number): number {
  return Math.max(1, Math.ceil(LOADOUT[slot].reloadMs / dtMs));
}

/**
 * A shot as the frame that took it saw the world: the weapon, the eye it left from and the
 * direction it was aimed in. Carried rather than re-derived from the shooter, because two
 * input frames periodically land in one tick and the later one's aim is not the aim the
 * trigger was pulled with.
 */
export interface Shot {
  readonly slot: WeaponSlot;
  readonly origin: Vec3;
  /** Unit vector, from `aimDirection` at the firing frame's yaw and pitch. */
  readonly direction: Vec3;
}

/** Who this shot reaches, or null for a miss. */
function traceShot(state: GameState, shooter: PlayerSimState, shot: Shot): PlayerId | null {
  const { origin, direction } = shot;
  const range = LOADOUT[shot.slot].rangeMeters;

  let nearest: { id: PlayerId; distance: number } | null = null;
  for (const target of state.players) {
    // The shooter's own eye is inside their own box, so distance alone would make every
    // trigger pull a suicide. A corpse is not cover either.
    if (target.id === shooter.id || target.health === 0) continue;

    const distance = rayHitsAabb(origin, direction, playerBox(target.movement.position), range);
    // Zero metres means the eye is inside that player's box. Nothing pushes two players
    // apart in v1, so standing in each other is reachable play — and a hit at zero
    // distance would mean whichever of them fired hit the other whatever they were
    // looking at. Step apart to shoot.
    if (distance !== null && distance > 0 && (nearest === null || distance < nearest.distance)) {
      nearest = { id: target.id, distance };
    }
  }
  if (nearest === null) return null;

  // The map is traced once, no further than the nearest player: anything solid closer than
  // they are is closer than every other player on this ray too, so there is no second
  // candidate to fall back to. A wall at exactly that distance blocks.
  return rayHitsMap(state.map, origin, direction, nearest.distance) === null ? nearest.id : null;
}

/** A round out of one magazine, and the tick that magazine comes back if it was the last. */
interface Spend {
  readonly slot: WeaponSlot;
  readonly reloadingUntilTick: number;
}

const spend = (
  ammo: Readonly<Record<WeaponSlot, SlotAmmo>>,
  round: Spend,
): Readonly<Record<WeaponSlot, SlotAmmo>> => ({
  ...ammo,
  [round.slot]: {
    ...ammo[round.slot],
    magazine: ammo[round.slot].magazine - 1,
    reloadingUntilTick: round.reloadingUntilTick,
  },
});

/** One shot that reached somebody and cost them health. */
interface Hit {
  readonly shooterId: PlayerId;
  readonly targetId: PlayerId;
  readonly slot: WeaponSlot;
  readonly damage: number;
}

/** Everything that landed on one player this tick, and who landed the last of it. */
interface Landed {
  readonly damage: number;
  readonly lastShooterId: PlayerId;
  readonly lastSlot: WeaponSlot;
}

/**
 * Every shot asked for this tick, resolved against the state the tick left behind.
 *
 * Deliberately one pass over a frozen world: who may shoot, where everyone is standing and
 * how much health they have are all read before any damage is applied. Resolving them one
 * at a time instead would let whoever happened to be iterated first survive a trade, which
 * is an outcome no test could pin and no player could explain.
 *
 * Each shot carries its own ray, taken at the frame that fired it; only the targets come
 * from the world this tick left behind. There is no rewind buffer — PLAN.md's stated
 * LAN-only ceiling — so a target is hit where the server has it now, not where the shooter
 * saw it.
 */
export function resolveShots(
  state: GameState,
  requested: ReadonlyMap<PlayerId, Shot>,
  dtMs: number,
): SimResult {
  // The same state object back, not a copy: a tick in which nothing was fired must not
  // look like a change to anybody comparing states.
  if (requested.size === 0) return { state, events: [] };

  // Who actually pulls a trigger this tick, in player order rather than the order the
  // requests arrived in, so the result is a function of the state alone. Collected before
  // anything is resolved because firing is what gives up spawn protection: two protected
  // players who shoot each other in the same tick have both given it up, and the trade
  // has to land both ways or neither.
  const firing = state.players.flatMap((shooter) => {
    const shot = requested.get(shooter.id);
    if (shot === undefined || shooter.health === 0 || state.tick < shooter.nextFireTick) return [];
    // An empty magazine is not a shot: nothing leaves the barrel, so nothing is traced,
    // no cooldown is spent, and spawn protection is not given up. Firing is what gives
    // protection up because it buys ground while invulnerable, and a dry click buys none
    // — the weapon that rule was written about, the knife, can never be dry.
    if (usesAmmo(shot.slot) && shooter.ammo[shot.slot].magazine === 0) return [];
    return [{ shooter, shot }];
  });
  if (firing.length === 0) return { state, events: [] };

  const hits: Hit[] = [];
  /** Earliest tick each shooter may fire anything again. */
  const cooledUntil = new Map<PlayerId, number>();
  /** The slot each shooter spent a round from, and the tick its magazine comes back. */
  const spent = new Map<PlayerId, Spend>();
  const unprotected = new Set(firing.map(({ shooter }) => shooter.id));

  for (const { shooter, shot } of firing) {
    // Spent on a miss as much as on a hit.
    cooledUntil.set(shooter.id, state.tick + fireCooldownTicks(shot.slot, dtMs));
    if (usesAmmo(shot.slot)) {
      const emptied = shooter.ammo[shot.slot].magazine === 1;
      spent.set(shooter.id, {
        slot: shot.slot,
        // The round that empties a magazine starts its reload. Only this slot's clock:
        // the fire cooldown is shared so that switching cannot outpace either weapon,
        // but locking the other two for a reload would make the loadout pointless.
        reloadingUntilTick: emptied ? state.tick + reloadTicks(shot.slot, dtMs) : 0,
      });
    }

    const targetId = traceShot(state, shooter, shot);
    if (targetId === null) continue;
    // A protected player is still a body: the bullet stops on them, it just costs them
    // nothing. Passing through would make them a window to shoot whoever stood behind.
    // It is not a hit either — a marker for a shot that cost nothing teaches the shooter
    // that their aim worked when it did not.
    const target = state.players.find((player) => player.id === targetId);
    if (target && isSpawnProtected(target, state.tick) && !unprotected.has(targetId)) continue;

    hits.push({
      shooterId: shooter.id,
      targetId,
      slot: shot.slot,
      damage: LOADOUT[shot.slot].damage,
    });
  }

  // Folded from the hits rather than accumulated beside them, so the damage a target takes
  // and the hits reported to whoever dealt it cannot come apart.
  const landed = new Map<PlayerId, Landed>();
  for (const hit of hits) {
    landed.set(hit.targetId, {
      damage: (landed.get(hit.targetId)?.damage ?? 0) + hit.damage,
      lastShooterId: hit.shooterId,
      lastSlot: hit.slot,
    });
  }

  const kills = new Map<PlayerId, number>();
  const deaths: ServerMessage[] = [];
  for (const victim of state.players) {
    const blow = landed.get(victim.id);
    if (!blow || victim.health === 0 || blow.damage < victim.health) continue;
    kills.set(blow.lastShooterId, (kills.get(blow.lastShooterId) ?? 0) + 1);
    // The same expression the victim's own `respawnAtTick` is written with below, so the
    // killfeed's countdown and the snapshot's cannot disagree. The credit is the same
    // field the score increment reads, so neither can the feed and the scoreboard.
    deaths.push({
      type: "death",
      victimId: victim.id,
      killerId: blow.lastShooterId,
      slot: blow.lastSlot,
      respawnAtTick: state.tick + state.rules.respawnTicks,
    });
  }

  const next: GameState = {
    ...state,
    players: state.players.map((player) => {
      const blow = landed.get(player.id);
      const ready = cooledUntil.get(player.id);
      const round = spent.get(player.id);
      const scored = kills.get(player.id) ?? 0;
      const gaveUp = unprotected.has(player.id) && player.protectedUntilTick !== 0;
      if (!blow && ready === undefined && scored === 0 && !gaveUp) return player;

      const health = blow ? Math.max(0, player.health - blow.damage) : player.health;
      const killed = health === 0 && player.health > 0;
      return {
        ...player,
        health,
        score: player.score + scored,
        deaths: player.deaths + (killed ? 1 : 0),
        // Counted from the tick the blow landed on. The countdown is the whole of what a
        // death is in v1: nothing else is remembered about it until M6 wants a killfeed.
        respawnAtTick: killed ? state.tick + state.rules.respawnTicks : player.respawnAtTick,
        // Protection is a moment to get your bearings in, not a licence to shoot from
        // behind: taking a shot ends it, whether or not the shot hit anything.
        protectedUntilTick: gaveUp ? 0 : player.protectedUntilTick,
        nextFireTick: ready ?? player.nextFireTick,
        ammo: round === undefined ? player.ammo : spend(player.ammo, round),
      };
    }),
  };

  // Every trigger pulled, then everything that landed, then everyone who died — all three
  // in player order, so a replay of the same inputs produces the same list. `hit` carries
  // the health the target is left with after the *whole* tick, because the world these
  // shots were resolved against is frozen and there is no per-shot order to subtract in:
  // two people who land on one target this tick are both told the same number.
  const healthOf = (id: PlayerId): number =>
    next.players.find((player) => player.id === id)?.health ?? 0;

  const events: ServerMessage[] = [
    ...firing.map(
      ({ shooter, shot }): ServerMessage => ({
        type: "shot",
        shooterId: shooter.id,
        slot: shot.slot,
      }),
    ),
    ...hits.map(
      (hit): ServerMessage => ({ type: "hit", ...hit, remainingHealth: healthOf(hit.targetId) }),
    ),
    ...deaths,
  ];

  return { state: next, events };
}

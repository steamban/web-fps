import {
  LOADOUT,
  type PlayerId,
  playerBox,
  rayHitsAabb,
  rayHitsMap,
  type Vec3,
  type WeaponSlot,
} from "@web-fps/shared";
import type { GameState, PlayerSimState } from "./simulation";

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
    if (distance !== null && (nearest === null || distance < nearest.distance)) {
      nearest = { id: target.id, distance };
    }
  }
  if (nearest === null) return null;

  // The map is traced once, no further than the nearest player: anything solid closer than
  // they are is closer than every other player on this ray too, so there is no second
  // candidate to fall back to. A wall at exactly that distance blocks.
  return rayHitsMap(state.map, origin, direction, nearest.distance) === null ? nearest.id : null;
}

/** Damage landed on one player this tick, and who landed the last of it. */
interface Landed {
  readonly damage: number;
  readonly lastShooterId: PlayerId;
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
): GameState {
  if (requested.size === 0) return state;

  const landed = new Map<PlayerId, Landed>();
  const reloaded = new Map<PlayerId, number>();

  // Player order, never the order the requests arrived in, so the result is a function of
  // the state alone.
  for (const shooter of state.players) {
    const shot = requested.get(shooter.id);
    if (shot === undefined || shooter.health === 0 || state.tick < shooter.nextFireTick) continue;
    // Spent on a miss as much as on a hit.
    reloaded.set(shooter.id, state.tick + fireCooldownTicks(shot.slot, dtMs));

    const targetId = traceShot(state, shooter, shot);
    if (targetId === null) continue;
    const already = landed.get(targetId)?.damage ?? 0;
    landed.set(targetId, {
      damage: already + LOADOUT[shot.slot].damage,
      lastShooterId: shooter.id,
    });
  }
  if (landed.size === 0 && reloaded.size === 0) return state;

  const kills = new Map<PlayerId, number>();
  for (const victim of state.players) {
    const blow = landed.get(victim.id);
    if (!blow || victim.health === 0 || blow.damage < victim.health) continue;
    kills.set(blow.lastShooterId, (kills.get(blow.lastShooterId) ?? 0) + 1);
  }

  return {
    ...state,
    players: state.players.map((player) => {
      const blow = landed.get(player.id);
      const ready = reloaded.get(player.id);
      const scored = kills.get(player.id) ?? 0;
      if (!blow && ready === undefined && scored === 0) return player;

      const health = blow ? Math.max(0, player.health - blow.damage) : player.health;
      return {
        ...player,
        health,
        score: player.score + scored,
        deaths: player.deaths + (health === 0 && player.health > 0 ? 1 : 0),
        nextFireTick: ready ?? player.nextFireTick,
      };
    }),
  };
}

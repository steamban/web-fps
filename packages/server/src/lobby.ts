import type { PlayerId, ServerMessage } from "@web-fps/shared";
import type { Config } from "./config";

/**
 * The lobby state machine, as pure functions: `(state, args) -> { state, effects }`.
 *
 * Nothing here knows about sockets, timers or `Date.now()` — the same reason the
 * authoritative sim will be a pure reducer in M3 (see PLAN.md "Server simulation as a
 * pure reducer"). Every transition is therefore testable by calling it, and `net.ts`
 * is the only place that has to be right about I/O.
 */

export interface LobbyMember {
  readonly id: PlayerId;
  readonly name: string;
}

export interface LobbyState {
  readonly phase: "waiting" | "inProgress" | "paused" | "ended";
  /** Join order. The first member is the host, so promotion on departure is implicit. */
  readonly members: readonly LobbyMember[];
}

/**
 * What the transport must do on the lobby's behalf. `sync` means "send every member the
 * current lobby state" — it cannot be a single pre-built message because `lobbyState`
 * carries a per-recipient `selfId`.
 */
export type LobbyEffect =
  | { readonly kind: "send"; readonly to: PlayerId; readonly message: ServerMessage }
  | { readonly kind: "sync" }
  | { readonly kind: "disconnect"; readonly playerId: PlayerId };

export interface LobbyResult {
  readonly state: LobbyState;
  readonly effects: readonly LobbyEffect[];
}

export function createLobby(): LobbyState {
  return { phase: "waiting", members: [] };
}

/** Null only while the lobby is empty; the next person to connect becomes host. */
export function hostIdOf(state: LobbyState): PlayerId | null {
  return state.members[0]?.id ?? null;
}

const isHost = (state: LobbyState, actorId: PlayerId): boolean => hostIdOf(state) === actorId;

/** A host-only action attempted by anyone else is dropped, not answered. */
const ignored = (state: LobbyState): LobbyResult => ({ state, effects: [] });

const refuse = (
  state: LobbyState,
  playerId: PlayerId,
  reason: "lobbyFull" | "matchInProgress" | "lobbyClosed",
): LobbyResult => ({
  state,
  effects: [
    { kind: "send", to: playerId, message: { type: "kicked", reason } },
    { kind: "disconnect", playerId },
  ],
});

export function join(state: LobbyState, config: Config, member: LobbyMember): LobbyResult {
  if (state.phase === "ended") return refuse(state, member.id, "lobbyClosed");
  if (state.phase !== "waiting") return refuse(state, member.id, "matchInProgress");
  if (state.members.length >= config.maxPlayers) return refuse(state, member.id, "lobbyFull");

  return {
    state: { ...state, members: [...state.members, member] },
    effects: [{ kind: "sync" }],
  };
}

export function leave(state: LobbyState, playerId: PlayerId): LobbyResult {
  const members = state.members.filter((member) => member.id !== playerId);
  if (members.length === state.members.length) return ignored(state);
  // An emptied lobby resets: there is nobody left to host, pause or watch a scoreboard.
  if (members.length === 0) return { state: createLobby(), effects: [] };

  return { state: { ...state, members }, effects: [{ kind: "sync" }] };
}

export function start(state: LobbyState, config: Config, actorId: PlayerId): LobbyResult {
  if (!isHost(state, actorId) || state.phase !== "waiting") return ignored(state);
  // Dev mode exists so movement and combat can be playtested alone — see PLAN.md.
  if (state.members.length < config.minPlayers && !config.isDevMode) return ignored(state);

  return { state: { ...state, phase: "inProgress" }, effects: [{ kind: "sync" }] };
}

export function setPaused(state: LobbyState, actorId: PlayerId, paused: boolean): LobbyResult {
  if (!isHost(state, actorId)) return ignored(state);
  if (state.phase !== (paused ? "inProgress" : "paused")) return ignored(state);

  return {
    state: { ...state, phase: paused ? "paused" : "inProgress" },
    effects: [{ kind: "sync" }],
  };
}

export function kick(state: LobbyState, actorId: PlayerId, targetId: PlayerId): LobbyResult {
  if (!isHost(state, actorId) || targetId === actorId) return ignored(state);
  if (!state.members.some((member) => member.id === targetId)) return ignored(state);

  const after = leave(state, targetId);
  return {
    state: after.state,
    effects: [
      { kind: "send", to: targetId, message: { type: "kicked", reason: "host" } },
      { kind: "disconnect", playerId: targetId },
      ...after.effects,
    ],
  };
}

/**
 * Closing empties the lobby rather than parking it in `ended`, so the server stays
 * usable: the next person to connect hosts a fresh match. The `ended` phase and its
 * scoreboard arrive with the round flow in M5.
 */
export function close(state: LobbyState, actorId: PlayerId): LobbyResult {
  if (!isHost(state, actorId)) return ignored(state);

  return {
    state: createLobby(),
    effects: state.members.flatMap((member): LobbyEffect[] => [
      { kind: "send", to: member.id, message: { type: "kicked", reason: "lobbyClosed" } },
      { kind: "disconnect", playerId: member.id },
    ]),
  };
}

/** The `lobbyState` frame as one recipient should see it. */
export function lobbyStateFor(
  state: LobbyState,
  config: Config,
  recipientId: PlayerId,
): ServerMessage {
  const hostId = hostIdOf(state);
  return {
    type: "lobbyState",
    phase: state.phase,
    hostId,
    selfId: recipientId,
    // The effective minimum, not the configured one: dev mode lets a host start solo, and
    // the client uses this to decide whether Start is available.
    minPlayers: config.isDevMode ? 1 : config.minPlayers,
    maxPlayers: config.maxPlayers,
    players: state.members.map((member) => ({
      id: member.id,
      name: member.name,
      isHost: member.id === hostId,
    })),
  };
}

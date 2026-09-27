import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "./config";
import {
  close,
  createLobby,
  finish,
  hostIdOf,
  join,
  kick,
  type LobbyState,
  leave,
  lobbyStateFor,
  restart,
  setPaused,
  start,
} from "./lobby";

const config = loadConfig({});
const devConfig = loadConfig({ GAME_MODE: "dev" });

/** Seats `count` players so a test can start from a populated lobby. */
function lobbyOf(count: number, cfg: Config = config): LobbyState {
  let state = createLobby();
  for (let i = 1; i <= count; i += 1) {
    state = join(state, cfg, { id: `p${i}`, name: `player${i}` }).state;
  }
  return state;
}

const ids = (state: LobbyState) => state.members.map((m) => m.id);

describe("join", () => {
  it("seats the first player as host", () => {
    const { state } = join(createLobby(), config, { id: "p1", name: "arvind" });
    expect(ids(state)).toEqual(["p1"]);
    expect(hostIdOf(state)).toBe("p1");
  });

  it("keeps the first joiner as host when others arrive", () => {
    expect(hostIdOf(lobbyOf(3))).toBe("p1");
  });

  it("tells every member about the new arrival", () => {
    const { effects } = join(lobbyOf(1), config, { id: "p2", name: "bob" });
    expect(effects).toEqual([{ kind: "sync" }]);
  });

  it("rejects a joiner once the lobby is full", () => {
    const full = lobbyOf(config.maxPlayers);
    const { state, effects } = join(full, config, { id: "late", name: "late" });

    expect(ids(state)).toEqual(ids(full));
    expect(effects).toEqual([
      { kind: "send", to: "late", message: { type: "kicked", reason: "lobbyFull" } },
      { kind: "disconnect", playerId: "late" },
    ]);
  });

  it("rejects a joiner once the match is under way", () => {
    for (const phase of ["inProgress", "paused"] as const) {
      const started = { ...lobbyOf(2), phase };
      const { state, effects } = join(started, config, { id: "late", name: "late" });

      expect(ids(state)).toEqual(["p1", "p2"]);
      expect(effects[0]).toEqual({
        kind: "send",
        to: "late",
        message: { type: "kicked", reason: "matchInProgress" },
      });
    }
  });

  it("rejects a joiner watching for the scoreboard to end", () => {
    // `ended` is the intermission between two matches: as closed to a newcomer as a
    // running one, and for the same reason — there is no match for them to appear in.
    const ended = { ...lobbyOf(2), phase: "ended" as const };
    expect(join(ended, config, { id: "late", name: "late" }).effects[0]).toEqual({
      kind: "send",
      to: "late",
      message: { type: "kicked", reason: "matchInProgress" },
    });
  });
});

describe("leave", () => {
  it("removes the player and tells the rest", () => {
    const { state, effects } = leave(lobbyOf(3), "p2");
    expect(ids(state)).toEqual(["p1", "p3"]);
    expect(effects).toEqual([{ kind: "sync" }]);
  });

  it("promotes the longest-connected player when the host leaves", () => {
    const { state } = leave(lobbyOf(3), "p1");
    expect(hostIdOf(state)).toBe("p2");
    expect(ids(state)).toEqual(["p2", "p3"]);
  });

  it("ignores a player who was never seated", () => {
    const before = lobbyOf(2);
    expect(leave(before, "ghost")).toEqual({ state: before, effects: [] });
  });

  it("resets to a fresh waiting lobby once the last player leaves", () => {
    const emptied = leave({ ...lobbyOf(1), phase: "inProgress" }, "p1").state;
    expect(emptied).toEqual(createLobby());
    expect(hostIdOf(emptied)).toBeNull();
  });
});

describe("start", () => {
  it("begins the match for the host once minPlayers is met", () => {
    const { state, effects } = start(lobbyOf(2), config, "p1");
    expect(state.phase).toBe("inProgress");
    expect(effects).toEqual([{ kind: "sync" }]);
  });

  it("refuses below minPlayers", () => {
    const waiting = lobbyOf(1);
    expect(start(waiting, config, "p1")).toEqual({ state: waiting, effects: [] });
  });

  it("lets a solo host start in dev mode", () => {
    expect(start(lobbyOf(1, devConfig), devConfig, "p1").state.phase).toBe("inProgress");
  });

  it("refuses a non-host", () => {
    const waiting = lobbyOf(3);
    expect(start(waiting, config, "p2")).toEqual({ state: waiting, effects: [] });
    expect(start(waiting, config, "ghost")).toEqual({ state: waiting, effects: [] });
  });

  it("refuses to start a match that is already running", () => {
    const running = { ...lobbyOf(2), phase: "inProgress" as const };
    expect(start(running, config, "p1")).toEqual({ state: running, effects: [] });
  });
});

describe("setPaused", () => {
  it("pauses and resumes a running match for the host", () => {
    const running = { ...lobbyOf(2), phase: "inProgress" as const };
    const paused = setPaused(running, "p1", true);
    expect(paused.state.phase).toBe("paused");
    expect(paused.effects).toEqual([{ kind: "sync" }]);
    expect(setPaused(paused.state, "p1", false).state.phase).toBe("inProgress");
  });

  it("refuses a non-host", () => {
    const running = { ...lobbyOf(2), phase: "inProgress" as const };
    expect(setPaused(running, "p2", true)).toEqual({ state: running, effects: [] });
  });

  it("does nothing while the lobby is still waiting", () => {
    const waiting = lobbyOf(2);
    expect(setPaused(waiting, "p1", true)).toEqual({ state: waiting, effects: [] });
  });

  it("ignores a redundant pause or resume", () => {
    const paused = { ...lobbyOf(2), phase: "paused" as const };
    expect(setPaused(paused, "p1", true)).toEqual({ state: paused, effects: [] });
  });
});

describe("kick", () => {
  it("removes the target, tells them why, and resyncs the rest", () => {
    const { state, effects } = kick(lobbyOf(3), "p1", "p2");
    expect(ids(state)).toEqual(["p1", "p3"]);
    expect(effects).toEqual([
      { kind: "send", to: "p2", message: { type: "kicked", reason: "host" } },
      { kind: "disconnect", playerId: "p2" },
      { kind: "sync" },
    ]);
  });

  it("refuses a non-host", () => {
    const seated = lobbyOf(3);
    expect(kick(seated, "p2", "p3")).toEqual({ state: seated, effects: [] });
  });

  it("refuses to kick the host themselves", () => {
    const seated = lobbyOf(3);
    expect(kick(seated, "p1", "p1")).toEqual({ state: seated, effects: [] });
  });

  it("ignores a target who is not in the lobby", () => {
    const seated = lobbyOf(3);
    expect(kick(seated, "p1", "ghost")).toEqual({ state: seated, effects: [] });
  });

  it("works while the match is running", () => {
    const running = { ...lobbyOf(3), phase: "inProgress" as const };
    const { state } = kick(running, "p1", "p3");
    expect(ids(state)).toEqual(["p1", "p2"]);
    expect(state.phase).toBe("inProgress");
  });
});

describe("finish", () => {
  const running = { ...lobbyOf(2), phase: "inProgress" as const };

  it("puts the scoreboard up", () => {
    const result = finish(running);

    expect(result.state.phase).toBe("ended");
    expect(result.effects).toEqual([{ kind: "sync" }]);
  });

  it("ends a paused match too", () => {
    expect(finish({ ...running, phase: "paused" }).state.phase).toBe("ended");
  });

  it("does nothing to a lobby that was not playing", () => {
    for (const phase of ["waiting", "ended"] as const) {
      const result = finish({ ...running, phase });
      expect(result.state.phase).toBe(phase);
      expect(result.effects).toEqual([]);
    }
  });
});

describe("restart", () => {
  const ended = { ...lobbyOf(2), phase: "ended" as const };

  it("goes straight into the next match on the same map", () => {
    const result = restart(ended, config);

    expect(result.state.phase).toBe("inProgress");
    expect(ids(result.state)).toEqual(["p1", "p2"]);
    expect(result.effects).toEqual([{ kind: "sync" }]);
  });

  it("waits instead when too many people left during the match", () => {
    // Restarting into a deathmatch for one is worse than sitting in the lobby until
    // somebody comes back — and it is a match the host could not have started by hand.
    const alone = { ...ended, members: ended.members.slice(0, 1) };

    expect(restart(alone, config).state.phase).toBe("waiting");
    expect(restart(alone, devConfig).state.phase).toBe("inProgress");
  });

  it("does nothing unless a scoreboard is up", () => {
    for (const phase of ["waiting", "inProgress", "paused"] as const) {
      expect(restart({ ...ended, phase }, config).effects).toEqual([]);
    }
  });
});

describe("close", () => {
  it("disconnects everyone with a reason", () => {
    const { effects } = close(lobbyOf(2), "p1");
    expect(effects).toEqual([
      { kind: "send", to: "p1", message: { type: "kicked", reason: "lobbyClosed" } },
      { kind: "disconnect", playerId: "p1" },
      { kind: "send", to: "p2", message: { type: "kicked", reason: "lobbyClosed" } },
      { kind: "disconnect", playerId: "p2" },
    ]);
  });

  it("leaves a fresh lobby behind so the next joiner hosts", () => {
    expect(close({ ...lobbyOf(2), phase: "inProgress" }, "p1").state).toEqual(createLobby());
  });

  it("refuses a non-host", () => {
    const seated = lobbyOf(2);
    expect(close(seated, "p2")).toEqual({ state: seated, effects: [] });
  });
});

describe("lobbyStateFor", () => {
  it("addresses the message to its recipient and flags the host", () => {
    expect(lobbyStateFor(lobbyOf(2), config, "p2")).toEqual({
      type: "lobbyState",
      phase: "waiting",
      hostId: "p1",
      selfId: "p2",
      minPlayers: 2,
      maxPlayers: 8,
      debug: false,
      players: [
        { id: "p1", name: "player1", isHost: true },
        { id: "p2", name: "player2", isHost: false },
      ],
    });
  });

  it("reports the minimum the host can actually start on in dev mode, and the overlay", () => {
    expect(lobbyStateFor(lobbyOf(1, devConfig), devConfig, "p1")).toMatchObject({
      minPlayers: 1,
      maxPlayers: 8,
      debug: true,
    });
  });

  it("reports an empty lobby with no host", () => {
    expect(lobbyStateFor(createLobby(), config, "p1")).toMatchObject({
      hostId: null,
      players: [],
    });
  });
});

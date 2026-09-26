// @vitest-environment happy-dom
import {
  type ClientMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  SANDBOX_MAP,
  type ServerMessage,
} from "@web-fps/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HTML from "../index.html?raw";

/**
 * Cover for the join screen. `main.ts` drives the DOM directly, so the markup comes from
 * the real index.html — which also means a rename that breaks an element id fails here
 * rather than in a browser.
 *
 * The match itself is stubbed out: `game.ts` builds a WebGL context, which happy-dom has
 * none of. What is worth covering here is the handover — which screen is up, and whether
 * the renderer was built or torn down — because a match left running over the join form
 * is the failure this file exists to catch.
 */

const game = vi.hoisted(() => ({
  startGame: vi.fn(),
  dispose: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("./game", () => ({ startGame: game.startGame }));

function matchStart(over: Record<string, unknown> = {}): ServerMessage {
  return {
    type: "matchStart",
    tick: 0,
    tickRateHz: 20,
    killLimit: 30,
    timeLimitMs: 600_000,
    map: SANDBOX_MAP,
    spawn: SANDBOX_MAP.spawns[0],
    ...over,
  } as ServerMessage;
}

const MARKUP = HTML.slice(HTML.indexOf("<main"), HTML.indexOf("</main>") + "</main>".length);

/** Stands in for the browser WebSocket, with the server side driven by the test. */
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: FakeSocket[] = [];

  readyState: number = FakeSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeSocket.opened.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  deliver(message: ServerMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: encodeMessage(message) }));
  }

  /** What a hung connect eventually does: an error, then a close. */
  fail(): void {
    this.dispatchEvent(new Event("error"));
    this.close();
  }

  frames(): ClientMessage[] {
    return this.sent.map((frame) => JSON.parse(frame) as ClientMessage);
  }
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`index.html is missing #${id}`);
  return node as T;
};

const lastSocket = (): FakeSocket => {
  const socket = FakeSocket.opened.at(-1);
  if (!socket) throw new Error("no connection was opened");
  return socket;
};

function submitJoin(address: string, name: string): FakeSocket | undefined {
  el<HTMLInputElement>("address").value = address;
  el<HTMLInputElement>("name").value = name;
  el<HTMLFormElement>("join-form").dispatchEvent(
    new Event("submit", { cancelable: true, bubbles: true }),
  );
  return FakeSocket.opened.at(-1);
}

function lobbyState(over: Record<string, unknown> = {}): ServerMessage {
  return {
    type: "lobbyState",
    phase: "waiting",
    hostId: "h",
    selfId: "h",
    minPlayers: 2,
    maxPlayers: 8,
    players: [
      { id: "h", name: "arvind", isHost: true },
      { id: "g", name: "bob", isHost: false },
    ],
    ...over,
  } as ServerMessage;
}

beforeEach(async () => {
  document.body.innerHTML = MARKUP;
  FakeSocket.opened = [];
  game.startGame.mockReset().mockReturnValue({ dispose: game.dispose, snapshot: game.snapshot });
  game.dispose.mockReset();
  game.snapshot.mockReset();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.resetModules();
  await import("./main");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("joining", () => {
  it("sends the join frame and shows the lobby the server reports", () => {
    const socket = submitJoin("192.168.1.5:8080", "arvind");
    expect(socket?.url).toBe("ws://192.168.1.5:8080/ws");

    socket?.accept();
    expect(socket?.frames()).toEqual([
      { type: "join", protocolVersion: PROTOCOL_VERSION, name: "arvind" },
    ]);

    socket?.deliver(lobbyState());
    expect(el("join-form").hidden).toBe(true);
    expect(el("lobby").hidden).toBe(false);
    expect(el("players").children).toHaveLength(2);
    expect(el("phase").textContent).toContain("Ready");
  });

  it("gives the host controls and hides them from everyone else", () => {
    const socket = submitJoin("192.168.1.5:8080", "arvind");
    socket?.accept();

    socket?.deliver(lobbyState());
    expect(el("host-controls").hidden).toBe(false);
    expect(el<HTMLButtonElement>("start").disabled).toBe(false);
    // One kick button, for the other player only.
    expect(el("players").querySelectorAll("button")).toHaveLength(1);

    socket?.deliver(lobbyState({ selfId: "g" }));
    expect(el("host-controls").hidden).toBe(true);
    expect(el("players").querySelectorAll("button")).toHaveLength(0);
  });

  it("will not let the host start below the reported minimum", () => {
    const socket = submitJoin("192.168.1.5:8080", "arvind");
    socket?.accept();
    socket?.deliver(lobbyState({ players: [{ id: "h", name: "arvind", isHost: true }] }));

    expect(el<HTMLButtonElement>("start").disabled).toBe(true);
    expect(el("phase").textContent).toContain("1 more");
  });

  it("refuses a name the wire schema would reject, without opening a connection", () => {
    expect(submitJoin("192.168.1.5:8080", "   ")).toBeUndefined();
    expect(el("status").textContent).toBe("Enter a name.");
    expect(FakeSocket.opened).toHaveLength(0);
  });

  it("accepts an emoji name built from a zero-width joiner", () => {
    const socket = submitJoin("192.168.1.5:8080", "\u{1F9D1}‍\u{1F4BB}arvind");
    socket?.accept();
    expect(socket?.frames()).toEqual([
      { type: "join", protocolVersion: PROTOCOL_VERSION, name: "\u{1F9D1}‍\u{1F4BB}arvind" },
    ]);
  });
});

describe("a second Join while the first connection is still pending", () => {
  /** The form stays up while a TCP connect to a mistyped address hangs, so this is routine. */
  const retypeAddress = () => {
    submitJoin("192.168.1.50:8080", "arvind");
    const abandoned = lastSocket();
    const live = submitJoin("192.168.1.5:8080", "arvind");
    live?.accept();
    live?.deliver(lobbyState());
    return { abandoned, live };
  };

  it("drops the abandoned connection so it cannot hold a lobby seat", () => {
    const { abandoned, live } = retypeAddress();
    expect(abandoned.readyState).toBe(FakeSocket.CLOSED);
    expect(abandoned.frames()).toEqual([]);
    expect(live?.readyState).toBe(FakeSocket.OPEN);
  });

  it("ignores the abandoned connection's failure instead of ejecting the player", () => {
    const { abandoned } = retypeAddress();

    abandoned.fail();

    expect(el("lobby").hidden).toBe(false);
    expect(el("join-form").hidden).toBe(true);
    expect(el("status").textContent).toBe("");
  });

  it("keeps the host controls wired to the live connection", () => {
    const { abandoned, live } = retypeAddress();
    abandoned.fail();

    el<HTMLButtonElement>("start").click();

    expect(live?.frames().at(-1)).toEqual({ type: "start" });
  });
});

describe("entering a match", () => {
  const joinedLobby = (): FakeSocket => {
    const socket = submitJoin("192.168.1.5:8080", "arvind");
    socket?.accept();
    socket?.deliver(lobbyState());
    if (!socket) throw new Error("no connection was opened");
    return socket;
  };

  it("waits for matchStart rather than entering on the lobby's phase", () => {
    // The phase carries no map to build a scene from, and it arrives again every time
    // somebody leaves — entering on it would rebuild the renderer each departure.
    const socket = joinedLobby();
    socket.deliver(lobbyState({ phase: "inProgress" }));

    expect(game.startGame).not.toHaveBeenCalled();
    expect(el("game").hidden).toBe(true);

    socket.deliver(matchStart());
    expect(el("game").hidden).toBe(false);
    expect(game.startGame).toHaveBeenCalledTimes(1);
  });

  it("hands the game its own id and the spawn the server seated it at", () => {
    joinedLobby().deliver(matchStart());
    expect(game.startGame).toHaveBeenCalledWith(
      expect.objectContaining({ selfId: "h", spawn: SANDBOX_MAP.spawns[0], tickRateHz: 20 }),
    );
  });

  it("stops predicting while the host has the match paused", () => {
    const socket = joinedLobby();
    socket.deliver(matchStart());
    const isRunning = game.startGame.mock.calls[0]?.[0]?.isRunning;

    expect(isRunning?.()).toBe(false);
    socket.deliver(lobbyState({ phase: "inProgress" }));
    expect(isRunning?.()).toBe(true);
    socket.deliver(lobbyState({ phase: "paused" }));
    expect(isRunning?.()).toBe(false);
  });

  it("forwards snapshots to the match and does not restart it when the lobby re-syncs", () => {
    const socket = joinedLobby();
    socket.deliver(matchStart());

    socket.deliver({ type: "snapshot", tick: 4, ackSeq: 2, players: [] });
    // A player leaving re-delivers the lobby to everyone still in the match.
    socket.deliver(
      lobbyState({ phase: "inProgress", players: [{ id: "h", name: "a", isHost: true }] }),
    );

    expect(game.snapshot).toHaveBeenCalledTimes(1);
    expect(game.startGame).toHaveBeenCalledTimes(1);
    expect(game.dispose).not.toHaveBeenCalled();
  });

  it("says so when the local player has been eliminated, and stops saying so", () => {
    const socket = joinedLobby();
    socket.deliver(matchStart());

    const self = (alive: boolean) => ({
      id: "h",
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      velocityY: 0,
      grounded: true,
      health: alive ? 100 : 0,
      alive,
      spawnProtected: false,
      respawnAtTick: alive ? null : 105,
      score: 0,
      deaths: alive ? 0 : 1,
    });

    socket.deliver({ type: "snapshot", tick: 4, ackSeq: 1, players: [self(true)] });
    expect(el("dead").hidden).toBe(true);

    socket.deliver({ type: "snapshot", tick: 5, ackSeq: 1, players: [self(false)] });
    expect(el("dead").hidden).toBe(false);

    // M5 respawns them; the banner has to go when it does.
    socket.deliver({ type: "snapshot", tick: 6, ackSeq: 1, players: [self(true)] });
    expect(el("dead").hidden).toBe(true);
  });

  it("rebuilds the view for the next round rather than playing on in the old one", () => {
    // The second matchStart is the round after a scoreboard. Reusing the renderer would
    // leave the player predicting from the spawn, and against the geometry, of the match
    // that just ended.
    const socket = joinedLobby();
    socket.deliver(matchStart());
    socket.deliver(matchStart({ tick: 0, spawn: SANDBOX_MAP.spawns[1] }));

    expect(game.startGame).toHaveBeenCalledTimes(2);
    expect(game.dispose).toHaveBeenCalledTimes(1);
    expect(game.startGame.mock.calls.at(-1)?.[0]).toMatchObject({
      spawn: SANDBOX_MAP.spawns[1],
    });
  });

  it("keeps the host's controls reachable over the match", () => {
    const socket = joinedLobby();
    socket.deliver(lobbyState({ phase: "inProgress" }));
    socket.deliver(matchStart());

    expect(el("host-controls").hidden).toBe(false);
    expect(el<HTMLButtonElement>("pause").hidden).toBe(false);
    el<HTMLButtonElement>("pause").click();
    expect(socket.frames().at(-1)).toEqual({ type: "pause", paused: true });
  });
});

describe("leaving", () => {
  it("tears the match down and puts the join screen back", () => {
    // Without this the frozen view stays over the form, still swallowing the keyboard.
    const socket = submitJoin("192.168.1.5:8080", "arvind");
    socket?.accept();
    socket?.deliver(lobbyState());
    socket?.deliver(matchStart());

    socket?.deliver({ type: "kicked", reason: "lobbyClosed" });
    socket?.close();

    expect(game.dispose).toHaveBeenCalledTimes(1);
    expect(el("game").hidden).toBe(true);
    expect(el("join-form").hidden).toBe(false);
    expect(el("status").textContent).toBe("The host closed the lobby.");
  });

  it("survives a connection that dies before any match started", () => {
    const socket = submitJoin("192.168.1.99:8080", "arvind");
    socket?.close();

    expect(game.dispose).not.toHaveBeenCalled();
    expect(el("game").hidden).toBe(true);
  });

  it("returns to the join screen with the reason the server gave", () => {
    const socket = submitJoin("192.168.1.5:8080", "arvind");
    socket?.accept();
    socket?.deliver(lobbyState());

    socket?.deliver({ type: "kicked", reason: "host" });
    socket?.close();

    expect(el("join-form").hidden).toBe(false);
    expect(el("lobby").hidden).toBe(true);
    expect(el("status").textContent).toBe("The host removed you from the lobby.");
  });

  it("explains an address that never answered", () => {
    const socket = submitJoin("192.168.1.99:8080", "arvind");
    socket?.fail();
    expect(el("status").textContent).toContain("Could not reach ws://192.168.1.99:8080/ws");
  });
});

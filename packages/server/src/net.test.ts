import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ClientMessage,
  decodeServerMessage,
  encodeMessage,
  LOADOUT,
  PROTOCOL_VERSION,
  type ServerMessage,
  WS_PATH,
} from "@web-fps/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "./config";
import { attachLobbyServer } from "./net";

/**
 * Integration cover for the socket shell only — the transitions themselves are proved in
 * lobby.test.ts without any I/O. What is worth a real server here is the part that cannot
 * be a pure function: identity per connection, routing, disconnect handling, and the wire
 * rejections that happen before a message ever reaches the lobby.
 */

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(teardown.splice(0).map((stop) => stop()));
});

async function startServer(config: Config = loadConfig({})): Promise<string> {
  const http: Server = createServer();
  const lobbyServer = attachLobbyServer(http, config);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  teardown.push(async () => {
    await lobbyServer.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return `ws://127.0.0.1:${(http.address() as AddressInfo).port}${WS_PATH}`;
}

async function waitFor<T>(get: () => T | undefined, what: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface TestClient {
  readonly inbox: ServerMessage[];
  readonly send: (message: ClientMessage) => void;
  readonly sendRaw: (frame: string) => void;
  readonly close: () => void;
  readonly isClosed: () => boolean;
}

async function connect(url: string): Promise<TestClient> {
  const socket = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  let closed = false;

  socket.addEventListener("message", (event) => {
    const message = decodeServerMessage(String(event.data));
    if (message) inbox.push(message);
  });
  socket.addEventListener("close", () => {
    closed = true;
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("connection failed")), { once: true });
  });

  return {
    inbox,
    send: (message) => socket.send(encodeMessage(message)),
    sendRaw: (frame) => socket.send(frame),
    close: () => socket.close(),
    isClosed: () => closed,
  };
}

/** The client's most recent `lobbyState`, once one satisfies `predicate`. */
function lobbyState(
  client: TestClient,
  predicate: (state: Extract<ServerMessage, { type: "lobbyState" }>) => boolean = () => true,
  what = "lobbyState",
) {
  return waitFor(() => {
    const latest = client.inbox.filter((m) => m.type === "lobbyState").at(-1);
    return latest && predicate(latest) ? latest : undefined;
  }, what);
}

const HELD = { forward: true, back: false, left: false, right: false, jump: false };

async function join(url: string, name: string): Promise<TestClient> {
  const client = await connect(url);
  client.send({ type: "join", protocolVersion: PROTOCOL_VERSION, name });
  return client;
}

describe("joining", () => {
  it("gives the first joiner an identity and makes them host", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");

    const state = await lobbyState(host);
    expect(state.selfId).toBe(state.hostId);
    expect(state.players).toEqual([{ id: state.selfId, name: "arvind", isHost: true }]);
    expect(state.phase).toBe("waiting");
    expect(state).toMatchObject({ minPlayers: 2, maxPlayers: 8 });
  });

  it("gives each connection a distinct id and tells everyone about the newcomer", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");

    const hostView = await lobbyState(host, (s) => s.players.length === 2);
    const guestView = await lobbyState(guest, (s) => s.players.length === 2);

    expect(guestView.selfId).not.toBe(hostView.selfId);
    expect(guestView.hostId).toBe(hostView.selfId);
    expect(guestView.players.map((p) => p.name)).toEqual(["arvind", "bob"]);
    expect(guestView.players.map((p) => p.isHost)).toEqual([true, false]);
  });

  it("turns a disconnect into a departure and promotes the next host", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");
    await lobbyState(guest, (s) => s.players.length === 2);

    host.close();

    const promoted = await lobbyState(guest, (s) => s.players.length === 1);
    expect(promoted.hostId).toBe(promoted.selfId);
  });

  it("refuses a joiner once the lobby is full", async () => {
    const url = await startServer(loadConfig({ MIN_PLAYERS: "1", MAX_PLAYERS: "2" }));
    await join(url, "arvind");
    await join(url, "bob");
    const late = await join(url, "late");

    await waitFor(() => late.inbox.at(-1), "kicked");
    expect(late.inbox).toEqual([{ type: "kicked", reason: "lobbyFull" }]);
    await waitFor(() => late.isClosed() || undefined, "socket to close");
  });

  it("refuses a joiner once the match is under way", async () => {
    const url = await startServer(loadConfig({ MIN_PLAYERS: "1" }));
    const host = await join(url, "arvind");
    await lobbyState(host);
    host.send({ type: "start" });
    await lobbyState(host, (s) => s.phase === "inProgress");

    const late = await join(url, "late");
    await waitFor(() => late.inbox.at(-1), "kicked");
    expect(late.inbox).toEqual([{ type: "kicked", reason: "matchInProgress" }]);
  });
});

describe("host-only actions", () => {
  it("starts the match when the host asks and minPlayers is met", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");
    await lobbyState(guest, (s) => s.players.length === 2);

    host.send({ type: "start" });

    expect((await lobbyState(guest, (s) => s.phase === "inProgress")).phase).toBe("inProgress");
  });

  it("ignores start, pause, kick and close from a non-host", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");
    const hostView = await lobbyState(host, (s) => s.players.length === 2);

    guest.send({ type: "start" });
    guest.send({ type: "pause", paused: true });
    guest.send({ type: "kick", targetId: hostView.hostId ?? "" });
    guest.send({ type: "close" });

    // Round-trip a host action the server *will* act on, so the ignored ones have landed.
    host.send({ type: "start" });
    const after = await lobbyState(guest, (s) => s.phase === "inProgress");

    expect(after.players).toHaveLength(2);
    expect(guest.isClosed()).toBe(false);
    expect(host.isClosed()).toBe(false);
  });

  it("pauses and resumes a running match", async () => {
    const url = await startServer(loadConfig({ MIN_PLAYERS: "1" }));
    const host = await join(url, "arvind");
    await lobbyState(host);

    host.send({ type: "start" });
    await lobbyState(host, (s) => s.phase === "inProgress");
    host.send({ type: "pause", paused: true });
    await lobbyState(host, (s) => s.phase === "paused");
    host.send({ type: "pause", paused: false });

    expect((await lobbyState(host, (s) => s.phase === "inProgress")).phase).toBe("inProgress");
  });

  it("kicks a named player and leaves the rest connected", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");
    const view = await lobbyState(host, (s) => s.players.length === 2);
    const guestId = view.players.find((p) => !p.isHost)?.id;

    host.send({ type: "kick", targetId: guestId ?? "" });

    await waitFor(
      () => guest.inbox.find((m) => m.type === "kicked") ?? undefined,
      "kick notice",
    ).then((message) => expect(message).toEqual({ type: "kicked", reason: "host" }));
    await waitFor(() => guest.isClosed() || undefined, "kicked socket to close");
    expect((await lobbyState(host, (s) => s.players.length === 1)).players).toHaveLength(1);
    expect(host.isClosed()).toBe(false);
  });

  it("closes the lobby for everyone", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");
    await lobbyState(guest, (s) => s.players.length === 2);

    host.send({ type: "close" });

    for (const client of [host, guest]) {
      await waitFor(() => client.inbox.find((m) => m.type === "kicked"), "close notice").then(
        (message) => expect(message).toEqual({ type: "kicked", reason: "lobbyClosed" }),
      );
      await waitFor(() => client.isClosed() || undefined, "socket to close");
    }

    // The server stays usable: the next connection hosts a fresh lobby.
    const next = await join(url, "carol");
    const fresh = await lobbyState(next);
    expect(fresh).toMatchObject({ phase: "waiting", players: [{ name: "carol", isHost: true }] });
  });
});

describe("wire rejections", () => {
  it("drops a connection that sends a frame it cannot parse", async () => {
    const url = await startServer();
    const client = await connect(url);
    client.sendRaw("{ not json");

    await waitFor(() => client.inbox.at(-1), "kicked");
    expect(client.inbox).toEqual([{ type: "kicked", reason: "invalidMessage" }]);
  });

  it("names a protocol mismatch so a stale client build is obvious", async () => {
    const url = await startServer();
    const client = await connect(url);
    client.sendRaw(
      JSON.stringify({ type: "join", protocolVersion: PROTOCOL_VERSION + 1, name: "stale" }),
    );

    await waitFor(() => client.inbox.at(-1), "kicked");
    expect(client.inbox).toEqual([{ type: "kicked", reason: "protocolMismatch" }]);
  });

  it("refuses any message sent before joining", async () => {
    const url = await startServer();
    const client = await connect(url);
    client.send({ type: "start" });

    await waitFor(() => client.inbox.at(-1), "kicked");
    expect(client.inbox).toEqual([{ type: "kicked", reason: "invalidMessage" }]);
  });

  it("refuses a second join on the same connection", async () => {
    const url = await startServer();
    const client = await join(url, "arvind");
    await lobbyState(client);

    client.send({ type: "join", protocolVersion: PROTOCOL_VERSION, name: "arvind-again" });

    await waitFor(() => client.inbox.find((m) => m.type === "kicked"), "kicked");
    expect(client.inbox.at(-1)).toEqual({ type: "kicked", reason: "invalidMessage" });
  });

  it("drops an input frame sent outside a match, shot and all, without kicking the sender", async () => {
    const url = await startServer();
    const client = await join(url, "arvind");
    await lobbyState(client);

    // Trigger pulled too: a shot rides its input frame, so it is dropped with it.
    client.send({ type: "input", seq: 1, keys: HELD, yaw: 0, pitch: 0, fire: "primary" });

    // A client whose loop starts a tick early is not a client to disconnect.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.isClosed()).toBe(false);
    expect(client.inbox.some((m) => m.type === "kicked")).toBe(false);
    expect(client.inbox.some((m) => m.type === "snapshot")).toBe(false);
  });
});

describe("a running match", () => {
  const solo = loadConfig({ MIN_PLAYERS: "1" });

  /** Starts a solo match and returns the host plus the `matchStart` they were sent. */
  async function startMatch(config = solo) {
    const url = await startServer(config);
    const host = await join(url, "arvind");
    await lobbyState(host);
    host.send({ type: "start" });
    const started = await waitFor(
      () => host.inbox.find((m) => m.type === "matchStart"),
      "matchStart",
    );
    return { url, host, started };
  }

  const snapshots = (client: TestClient) => client.inbox.filter((m) => m.type === "snapshot");

  it("sends matchStart, carrying the spawn that recipient was seated at", async () => {
    const { started } = await startMatch();

    expect(started.map.name).toBe("sandbox");
    expect(started.tickRateHz).toBe(solo.tickRateHz);
    expect(started.map.spawns).toContainEqual(started.spawn);
  });

  it("gives two players different spawns and tells each about both", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");
    await lobbyState(guest, (s) => s.players.length === 2);
    host.send({ type: "start" });

    const hostStart = await waitFor(() => host.inbox.find((m) => m.type === "matchStart"), "host");
    const guestStart = await waitFor(
      () => guest.inbox.find((m) => m.type === "matchStart"),
      "guest",
    );
    expect(hostStart.spawn).not.toEqual(guestStart.spawn);

    const snapshot = await waitFor(() => snapshots(guest).at(-1), "snapshot");
    expect(snapshot.players).toHaveLength(2);
  });

  it("starts broadcasting snapshots, and acks nothing until an input is simulated", async () => {
    const { host } = await startMatch();

    const first = await waitFor(() => snapshots(host).at(-1), "snapshot");
    expect(first.ackSeq).toBe(0);
    expect(first.players[0]).toMatchObject({
      health: 100,
      alive: true,
      grounded: expect.any(Boolean),
    });
  });

  it("moves the player the input asks for and acks the sequence it simulated", async () => {
    const { host, started } = await startMatch();
    await waitFor(() => snapshots(host).at(-1), "first snapshot");

    for (let seq = 1; seq <= 4; seq += 1) {
      host.send({ type: "input", seq, keys: HELD, yaw: 0, pitch: 0, fire: null });
    }

    const acked = await waitFor(() => snapshots(host).find((s) => s.ackSeq === 4), "ack of seq 4");
    // Yaw 0 faces -z, so holding forward walks them off their spawn along -z.
    expect(acked.players[0]?.position.z).toBeLessThan(started.spawn.position.z);
  });

  it("neither steps nor broadcasts while the host has it paused", async () => {
    const { host } = await startMatch();
    await waitFor(() => snapshots(host).at(-1), "first snapshot");

    host.send({ type: "pause", paused: true });
    await lobbyState(host, (s) => s.phase === "paused");

    const atPause = snapshots(host).at(-1);
    host.send({ type: "input", seq: 1, keys: HELD, yaw: 0, pitch: 0, fire: null });
    await new Promise((resolve) => setTimeout(resolve, 6 * solo.tickIntervalMs));
    expect(snapshots(host).at(-1)).toEqual(atPause);

    // Resuming must not replay the pause: input sent through it was dropped, not queued.
    host.send({ type: "pause", paused: false });
    const resumed = await waitFor(
      () => snapshots(host).find((s) => s.tick > (atPause?.tick ?? 0)),
      "a snapshot after the resume",
    );
    expect(resumed.players[0]?.position).toEqual(atPause?.players[0]?.position);
  });

  it("resolves a shot taken over the socket against the player it was aimed at", async () => {
    // The whole path end to end: a trigger on an input frame, the authoritative hit, and
    // the health every client learns about from the next snapshot. Spawn 0 and spawn 1 sit
    // 36 m apart along a clear lane; yaw -pi/2 looks straight down it.
    // No spawn protection: this is about the ballistics, and a protected player is unhittable.
    const url = await startServer(loadConfig({ SPAWN_PROTECTION_SECONDS: "0" }));
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");
    await lobbyState(guest, (s) => s.players.length === 2);
    host.send({ type: "start" });

    const started = await waitFor(() => host.inbox.find((m) => m.type === "matchStart"), "start");
    const selfId = (await lobbyState(host)).selfId;
    expect(started.spawn.position.x).toBeLessThan(0);

    host.send({
      type: "input",
      seq: 1,
      keys: { forward: false, back: false, left: false, right: false, jump: false },
      yaw: -Math.PI / 2,
      pitch: 0,
      fire: "primary",
    });

    const hit = await waitFor(
      () => snapshots(host).find((s) => s.players.some((p) => p.health < 100)),
      "a snapshot showing the hit",
    );
    const shooter = hit.players.find((player) => player.id === selfId);
    const target = hit.players.find((player) => player.id !== selfId);

    expect(target?.health).toBe(100 - LOADOUT.primary.damage);
    expect(target?.alive).toBe(true);
    // The client never decides a kill, and never shoots itself either.
    expect(shooter?.health).toBe(100);
  });

  it("stops simulating a player who leaves and keeps the match running for the rest", async () => {
    const url = await startServer();
    const host = await join(url, "arvind");
    const guest = await join(url, "bob");
    await lobbyState(guest, (s) => s.players.length === 2);
    host.send({ type: "start" });
    await waitFor(() => snapshots(host).find((s) => s.players.length === 2), "both players");

    guest.close();

    const alone = await waitFor(() => snapshots(host).find((s) => s.players.length === 1), "one");
    expect(alone.players[0]?.id).toBe((await lobbyState(host)).selfId);
  });

  it("ends the match when the last player leaves, and starts a fresh one afterwards", async () => {
    // The lobby resets with no effects at all when it empties, so a teardown hung off them
    // would leave the old match ticking and stack a second timer on the next one.
    const { url, host } = await startMatch();
    await waitFor(() => snapshots(host).at(-1), "snapshot");
    host.close();
    await new Promise((resolve) => setTimeout(resolve, 8 * solo.tickIntervalMs));

    const next = await join(url, "bob");
    const view = await lobbyState(next);
    expect(view.phase).toBe("waiting");
    next.send({ type: "start" });

    // A match the server never ended would still be holding the old player, and would
    // never hand this one a matchStart to enter it with.
    const started = await waitFor(() => next.inbox.find((m) => m.type === "matchStart"), "start");
    const restarted = await waitFor(() => snapshots(next).at(-1), "snapshot of the new match");

    expect(started.tick).toBe(0);
    expect(restarted.players.map((player) => player.id)).toEqual([view.selfId]);
  });
});

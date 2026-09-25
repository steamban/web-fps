import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  type ClientMessage,
  decodeClientMessage,
  encodeMessage,
  type KickReason,
  MAX_CATCHUP_MS,
  type PlayerId,
  PROTOCOL_VERSION,
  SANDBOX_MAP,
  type ServerMessage,
  WS_PATH,
} from "@web-fps/shared";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config";
import * as lobby from "./lobby";
import {
  createGame,
  type GameState,
  matchStartFor,
  type PlayerInput,
  retainPlayers,
  simulate,
  snapshotFor,
} from "./simulation";

/**
 * The socket shell around the lobby state machine and the authoritative simulation.
 * Everything stateful about the game lives in `lobby.ts` and `simulation.ts` as pure
 * transitions; this file owns only the things a pure function cannot: connection
 * identity, wire decoding, the clock, and carrying out the effects a transition asks for.
 */

/** A socket that misses a ping round is half-open and would otherwise hold a lobby seat. */
const HEARTBEAT_MS = 15_000;

interface Client {
  readonly socket: WebSocket;
  /** Cleared when a ping goes out, set again by the pong. */
  alive: boolean;
}

export interface LobbyServer {
  /** Drops every connection and stops accepting new ones. */
  close(): Promise<void>;
}

/** ws hands over a Buffer by default; a fragmented message can arrive as chunks. */
function frameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * `decodeClientMessage` returns null for a malformed frame and for a join from a build
 * speaking a different protocol version. Only the second is worth naming: it is the
 * failure a half-updated LAN party actually hits, and "invalid message" would send
 * someone hunting for a bug that is really a stale browser tab.
 */
function rejectionFor(raw: string): KickReason {
  try {
    const frame: unknown = JSON.parse(raw);
    if (typeof frame !== "object" || frame === null) return "invalidMessage";
    const { type, protocolVersion } = frame as { type?: unknown; protocolVersion?: unknown };
    if (type === "join" && protocolVersion !== PROTOCOL_VERSION) return "protocolMismatch";
  } catch {
    // Not JSON at all.
  }
  return "invalidMessage";
}

export function attachLobbyServer(httpServer: Server, config: Config): LobbyServer {
  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
  const clients = new Map<PlayerId, Client>();
  let state = lobby.createLobby();

  /** Inputs waiting for the next tick, oldest first, one queue per player. */
  const queues = new Map<PlayerId, PlayerInput[]>();
  let game: GameState | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  /**
   * A client coming back from a backgrounded tab releases its whole capped catch-up at
   * once, so the queue has to hold that much or a legitimate burst gets clipped.
   *
   * ponytail: this is also the ceiling on how much faster than everyone else a client that
   * sends faster than the tick rate can move. v1 has no anti-cheat (PLAN.md); the cap is
   * here so one client cannot make a tick take unbounded time, not to stop them cheating.
   */
  const maxQueuedInputs = Math.ceil(MAX_CATCHUP_MS / config.tickIntervalMs);

  const log = (message: string): void => {
    if (config.isDevMode) console.log(message);
  };

  function send(to: PlayerId, message: ServerMessage): void {
    const client = clients.get(to);
    if (client?.socket.readyState === WebSocket.OPEN) client.socket.send(encodeMessage(message));
  }

  /** One tick: drain what arrived, advance the simulation, tell everyone where they are. */
  function tick(): void {
    // The timer runs through a pause; the simulation does not, so a resumed match picks up
    // exactly where it stopped rather than replaying the pause.
    if (!game || state.phase !== "inProgress") return;

    const inputs: PlayerInput[] = [];
    for (const queued of queues.values()) {
      inputs.push(...queued.splice(0));
    }

    game = simulate(game, inputs, config.tickIntervalMs);
    for (const player of game.players) send(player.id, snapshotFor(game, player.id));
  }

  function beginMatch(): void {
    game = createGame(
      SANDBOX_MAP,
      state.members.map((member) => member.id),
    );
    // Per recipient, because each carries the spawn that player was actually seated at.
    for (const player of game.players) send(player.id, matchStartFor(game, config, player));

    ticker = setInterval(tick, config.tickIntervalMs);
    // The HTTP server already holds the process open; this timer must not do it on its own.
    ticker.unref();
    log(`match started with ${game.players.length} players`);
  }

  function endMatch(): void {
    if (ticker) clearInterval(ticker);
    ticker = null;
    game = null;
    queues.clear();
  }

  /**
   * A match exists exactly while the lobby says one is under way. Derived here rather than
   * raised as an effect because `leave` on the last member resets to a fresh lobby with no
   * effects at all — an effect-driven teardown would leave that match ticking forever.
   */
  function syncMatch(): void {
    if (state.phase !== "inProgress" && state.phase !== "paused") {
      endMatch();
      return;
    }
    if (!game) {
      beginMatch();
      return;
    }

    // Whoever has gone stops being simulated; the match carries on for everyone else.
    const members = new Set(state.members.map((member) => member.id));
    game = retainPlayers(game, members);
    for (const playerId of queues.keys()) if (!members.has(playerId)) queues.delete(playerId);
  }

  function apply(result: lobby.LobbyResult): void {
    state = result.state;
    for (const effect of result.effects) {
      switch (effect.kind) {
        case "send":
          send(effect.to, effect.message);
          break;
        case "sync":
          for (const member of state.members) {
            send(member.id, lobby.lobbyStateFor(state, config, member.id));
          }
          break;
        case "disconnect":
          // close() flushes what is already queued, so the `kicked` frame still lands.
          clients.get(effect.playerId)?.socket.close();
          break;
      }
    }
    syncMatch();
  }

  function enqueue(playerId: PlayerId, message: Extract<ClientMessage, { type: "input" }>): void {
    // Nothing to simulate outside a running match. Dropped rather than held: queueing
    // through a pause would burst the whole backlog into the tick that resumes it.
    if (!game || state.phase !== "inProgress") return;

    const queue = queues.get(playerId) ?? [];
    queue.push({
      playerId,
      seq: message.seq,
      keys: message.keys,
      yaw: message.yaw,
      pitch: message.pitch,
      fire: message.fire,
    });
    if (queue.length > maxQueuedInputs) queue.splice(0, queue.length - maxQueuedInputs);
    queues.set(playerId, queue);
  }

  function reject(id: PlayerId, reason: KickReason): void {
    log(`rejecting ${id}: ${reason}`);
    send(id, { type: "kicked", reason });
    clients.get(id)?.socket.close();
  }

  const isMember = (id: PlayerId): boolean => state.members.some((member) => member.id === id);

  function route(id: PlayerId, raw: string): void {
    const message = decodeClientMessage(raw);
    if (!message) {
      reject(id, rejectionFor(raw));
      return;
    }

    if (message.type === "join") {
      // A connection gets one identity; a second join is a confused or hostile client.
      if (isMember(id)) reject(id, "invalidMessage");
      else apply(lobby.join(state, config, { id, name: message.name }));
      return;
    }
    if (!isMember(id)) {
      reject(id, "invalidMessage");
      return;
    }

    switch (message.type) {
      case "start":
        apply(lobby.start(state, config, id));
        break;
      case "pause":
        apply(lobby.setPaused(state, id, message.paused));
        break;
      case "kick":
        apply(lobby.kick(state, id, message.targetId));
        break;
      case "close":
        apply(lobby.close(state, id));
        break;
      case "input":
        // A shot rides the frame that took it, so it is dropped outside a running match
        // with the rest of that frame rather than needing a guard of its own.
        enqueue(id, message);
        break;
    }
  }

  wss.on("connection", (socket) => {
    const id: PlayerId = randomUUID();
    clients.set(id, { socket, alive: true });
    log(`connection ${id}`);

    socket.on("message", (data) => route(id, frameText(data)));
    socket.on("pong", () => {
      const client = clients.get(id);
      if (client) client.alive = true;
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clients.delete(id);
      apply(lobby.leave(state, id));
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, HEARTBEAT_MS);
  // The HTTP server already holds the process open; this timer must not do it on its own.
  heartbeat.unref();

  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        endMatch();
        // ws withholds its own 'close' until every client has gone, so drop them first.
        for (const client of clients.values()) client.socket.terminate();
        wss.close(() => resolve());
      }),
  };
}

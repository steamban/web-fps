import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  type ClientMessage,
  decodeClientMessage,
  encodeMessage,
  type KickReason,
  MAX_CATCHUP_MS,
  type MatchEndReason,
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
  matchEndMessage,
  matchOutcome,
  matchStartFor,
  type PlayerInput,
  retainPlayers,
  roundRules,
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
  /** Runs while the scoreboard is up; the next match starts when it fires. */
  let intermission: ReturnType<typeof setTimeout> | null = null;

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

  /**
   * Who each of a tick's events is for. This is the one asymmetry with `snapshotFor` and
   * `lobbyStateFor`: those build a different frame per recipient, these are one frame with
   * a different audience, so there is nothing for a `hitFor(state, recipient)` to vary.
   */
  function dispatch(event: ServerMessage): void {
    // The marker belongs to whoever pulled the trigger; with two people shooting at one
    // target, the health drop on the snapshot says nothing about whose bullet did it.
    if (event.type === "hit") {
      send(event.shooterId, event);
      return;
    }
    for (const member of state.members) {
      // A shooter heard their own gun when they clicked, half a tick before this.
      if (event.type === "shot" && member.id === event.shooterId) continue;
      send(member.id, event);
    }
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

    const stepped = simulate(game, inputs, config.tickIntervalMs);
    game = stepped.state;
    for (const player of game.players) send(player.id, snapshotFor(game, player.id));
    // After the snapshots, always: the snapshot is the authority on who is alive and how
    // much health they have, and a killfeed line that arrived first would name a death on
    // a player its recipient is still drawing on their feet.
    for (const event of stepped.events) dispatch(event);

    // Asked of the state the tick just produced, so the snapshot everyone has in hand is
    // the one the scoreboard is about to be drawn from.
    const outcome = matchOutcome(game);
    if (outcome !== null) finishMatch(outcome);
  }

  /**
   * The match reached a limit: everyone sees the scoreboard, and the next one is put on
   * the clock before the lobby transition tears this one down — `finish` moves the phase
   * to `ended`, which `syncMatch` reads as "stop ticking", so the final state has to be
   * turned into a message first.
   */
  function finishMatch(reason: MatchEndReason): void {
    if (!game) return;
    const names = new Map(state.members.map((member) => [member.id, member.name]));
    const scoreboard = matchEndMessage(game, reason, names);
    for (const member of state.members) send(member.id, scoreboard);
    log(`match over: ${reason}`);

    intermission = setTimeout(() => {
      intermission = null;
      apply(lobby.restart(state, config));
    }, config.intermissionMs);
    // The HTTP server already holds the process open; this timer must not do it on its own.
    intermission.unref();

    apply(lobby.finish(state));
  }

  function beginMatch(): void {
    game = createGame(
      SANDBOX_MAP,
      state.members.map((member) => member.id),
      roundRules(config),
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

  function cancelIntermission(): void {
    if (intermission) clearTimeout(intermission);
    intermission = null;
  }

  /**
   * A match exists exactly while the lobby says one is under way. Derived here rather than
   * raised as an effect because `leave` on the last member resets to a fresh lobby with no
   * effects at all — an effect-driven teardown would leave that match ticking forever.
   */
  function syncMatch(): void {
    // The scoreboard is the one phase with no simulation under it and a timer still to
    // run: the match is torn down, the intermission is left alone. Anywhere else — the
    // next match starting, the lobby emptying, the host closing it — the timer goes too,
    // or it fires into a lobby that has moved on without it.
    if (state.phase === "ended") {
      endMatch();
      return;
    }
    if (state.phase !== "inProgress" && state.phase !== "paused") {
      endMatch();
      cancelIntermission();
      return;
    }
    if (!game) {
      cancelIntermission();
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
      reload: message.reload,
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
        // Reset before the sockets go, not after: every terminated socket still runs its
        // close handler, and a `leave` that finds the lobby still `inProgress` sends
        // `syncMatch` down the "no game, start one" branch — building a fresh match, and
        // a fresh ticker, on a server that is shutting down.
        state = lobby.createLobby();
        endMatch();
        cancelIntermission();
        // ws withholds its own 'close' until every client has gone, so drop them first.
        for (const client of clients.values()) client.socket.terminate();
        wss.close(() => resolve());
      }),
  };
}

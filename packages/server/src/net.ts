import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  decodeClientMessage,
  encodeMessage,
  type KickReason,
  type PlayerId,
  PROTOCOL_VERSION,
  type ServerMessage,
  WS_PATH,
} from "@web-fps/shared";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config";
import * as lobby from "./lobby";

/**
 * The socket shell around the lobby state machine. Everything stateful about the game
 * lives in `lobby.ts` as pure transitions; this file owns only the things a pure function
 * cannot: connection identity, wire decoding, and carrying out the effects a transition
 * asks for. The same split will hold for the authoritative simulation in M3.
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

  const log = (message: string): void => {
    if (config.isDevMode) console.log(message);
  };

  function send(to: PlayerId, message: ServerMessage): void {
    const client = clients.get(to);
    if (client?.socket.readyState === WebSocket.OPEN) client.socket.send(encodeMessage(message));
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
      case "fire":
        // Accepted but inert until the authoritative simulation lands in M3.
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
        // ws withholds its own 'close' until every client has gone, so drop them first.
        for (const client of clients.values()) client.socket.terminate();
        wss.close(() => resolve());
      }),
  };
}

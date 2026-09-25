import {
  type ClientMessage,
  decodeServerMessage,
  encodeMessage,
  type KickReason,
  PlayerNameSchema,
  PROTOCOL_VERSION,
  SANDBOX_MAP,
  type ServerMessage,
} from "@web-fps/shared";
import { type Game, startGame } from "./game";
import { startSandbox } from "./sandbox";
import { toWebSocketUrl } from "./serverUrl";

/**
 * The join screen: reach a host, see who else is in the lobby, and — if you got there
 * first — run it. When the host starts, `matchStart` hands over to `game.ts`; this file
 * keeps the socket and decides which screen is up, and never touches the renderer.
 *
 * The server is the authority on what each control does; the buttons only reflect the
 * last `lobbyState`, so a stale click is refused there rather than trusted here.
 *
 * The one thing here that needs no server is the movement sandbox, which runs the same
 * simulation locally against the same map.
 */

type LobbyState = Extract<ServerMessage, { type: "lobbyState" }>;
type MatchStart = Extract<ServerMessage, { type: "matchStart" }>;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const ui = {
  form: el<HTMLFormElement>("join-form"),
  address: el<HTMLInputElement>("address"),
  name: el<HTMLInputElement>("name"),
  lobby: el("lobby"),
  phase: el("phase"),
  players: el("players"),
  hostControls: el("host-controls"),
  start: el<HTMLButtonElement>("start"),
  pause: el<HTMLButtonElement>("pause"),
  close: el<HTMLButtonElement>("close"),
  status: el("status"),
  sandbox: el<HTMLButtonElement>("sandbox"),
  game: el("game"),
  view: el<HTMLCanvasElement>("view"),
};

const KICK_TEXT: Record<KickReason, string> = {
  host: "The host removed you from the lobby.",
  lobbyFull: "That lobby is full.",
  matchInProgress: "That match has already started — no late joining.",
  lobbyClosed: "The host closed the lobby.",
  protocolMismatch: "This client is a different version than the server. Reload the page.",
  invalidMessage: "The server rejected a message from this client.",
};

let socket: WebSocket | null = null;
let current: LobbyState | null = null;
let match: Game | null = null;
/** Set when the server names a reason, so the close handler does not overwrite it. */
let farewell: string | null = null;

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
}

function describePhase(state: LobbyState): string {
  const seats = `${state.players.length}/${state.maxPlayers}`;
  switch (state.phase) {
    case "waiting": {
      const missing = state.minPlayers - state.players.length;
      return missing > 0
        ? `Waiting — ${seats} players, ${missing} more before the host can start`
        : `Ready — ${seats} players`;
    }
    case "inProgress":
      return `Match in progress — ${seats} players`;
    case "paused":
      return `Paused by the host — ${seats} players`;
    case "ended":
      return `Match over — ${seats} players`;
  }
}

function playerRow(player: LobbyState["players"][number], state: LobbyState): HTMLLIElement {
  const row = document.createElement("li");
  const label = document.createElement("span");
  const tags = [player.isHost ? "host" : null, player.id === state.selfId ? "you" : null].filter(
    (tag) => tag !== null,
  );
  label.textContent = tags.length > 0 ? `${player.name} — ${tags.join(", ")}` : player.name;
  row.append(label);

  if (state.selfId === state.hostId && player.id !== state.selfId) {
    const kick = document.createElement("button");
    kick.type = "button";
    kick.textContent = "Kick";
    kick.addEventListener("click", () => send({ type: "kick", targetId: player.id }));
    row.append(kick);
  }
  return row;
}

function render(state: LobbyState): void {
  const isHost = state.selfId === state.hostId;
  const running = state.phase === "inProgress" || state.phase === "paused";

  ui.form.hidden = true;
  ui.lobby.hidden = false;
  ui.phase.textContent = describePhase(state);
  ui.players.replaceChildren(...state.players.map((player) => playerRow(player, state)));

  ui.hostControls.hidden = !isHost;
  ui.start.hidden = state.phase !== "waiting";
  ui.start.disabled = state.players.length < state.minPlayers;
  ui.pause.hidden = !running;
  ui.pause.textContent = state.phase === "paused" ? "Resume" : "Pause";
}

/**
 * Entered on `matchStart` and nothing else. A player leaving mid-match re-syncs the lobby
 * to everyone still in it, so entering on the phase would rebuild the renderer every time
 * somebody quit — and the phase carries no map to build it from anyway.
 */
function enterMatch(message: MatchStart): void {
  const selfId = current?.selfId;
  if (match || selfId === undefined) return;

  ui.game.hidden = false;
  match = startGame({
    canvas: ui.view,
    map: message.map,
    selfId,
    spawn: message.spawn,
    tickRateHz: message.tickRateHz,
    send,
    // The server stops stepping while the host has it paused, so this stops too.
    isRunning: () => current?.phase === "inProgress",
  });
}

function showJoinScreen(message: string): void {
  socket = null;
  current = null;
  // The one way out of a match in M3 is the socket closing, so this is the only teardown
  // there is to get right. Without it the frozen view stays over the form, still eating
  // the keyboard.
  match?.dispose();
  match = null;
  ui.game.hidden = true;
  ui.lobby.hidden = true;
  ui.form.hidden = false;
  ui.status.textContent = message;
}

// One way in, no way out but a reload — the sandbox is a tuning tool, not a screen the
// lobby navigates back and forth to.
ui.sandbox.addEventListener("click", () => {
  ui.form.hidden = true;
  ui.status.textContent = "";
  ui.game.hidden = false;
  startSandbox(ui.view, SANDBOX_MAP);
});

ui.start.addEventListener("click", () => send({ type: "start" }));
ui.close.addEventListener("click", () => send({ type: "close" }));
ui.pause.addEventListener("click", () =>
  send({ type: "pause", paused: current?.phase !== "paused" }),
);

ui.form.addEventListener("submit", (event) => {
  event.preventDefault();

  // The wire schema is the authority on names, so checking against it here turns what
  // would be a server disconnect into a message next to the field.
  const name = PlayerNameSchema.safeParse(ui.name.value);
  if (!name.success) {
    ui.status.textContent =
      ui.name.value.trim() === ""
        ? "Enter a name."
        : (name.error.issues[0]?.message ?? "That name will not work.");
    return;
  }

  let url: string;
  try {
    url = toWebSocketUrl(ui.address.value, location.protocol === "https:");
  } catch (error) {
    ui.status.textContent = error instanceof Error ? error.message : String(error);
    return;
  }

  farewell = null;
  ui.status.textContent = `Connecting to ${url}\u2026`;

  // A mistyped address leaves the form up for as long as the TCP connect hangs, so a second
  // Join is expected. Abandon the first attempt, and ignore its late events: without this
  // its eventual `close` would drop the player out of the lobby the second one just joined.
  const connection = new WebSocket(url);
  const previous = socket;
  socket = connection;
  previous?.close();

  const on = <K extends keyof WebSocketEventMap>(
    type: K,
    handler: (event: WebSocketEventMap[K]) => void,
  ): void => {
    connection.addEventListener(type, (event) => {
      if (socket === connection) handler(event);
    });
  };

  on("open", () => {
    ui.status.textContent = "";
    send({ type: "join", protocolVersion: PROTOCOL_VERSION, name: name.data });
  });

  on("message", (event) => {
    const message = decodeServerMessage(String(event.data));
    switch (message?.type) {
      case "lobbyState":
        current = message;
        // Kept up to date under a running match too: it is what the host's Pause and
        // Close read, and they stay reachable over the game view.
        render(message);
        break;
      case "matchStart":
        enterMatch(message);
        break;
      case "snapshot":
        match?.snapshot(message);
        break;
      case "kicked":
        // Explains a disconnect that is about to happen.
        farewell = KICK_TEXT[message.reason];
        break;
      default:
        break;
    }
  });

  on("error", () => {
    farewell ??= `Could not reach ${url}. Check the address and that the host is running.`;
  });

  on("close", () => {
    showJoinScreen(farewell ?? "Disconnected.");
  });
});

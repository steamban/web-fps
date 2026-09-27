import {
  type ClientMessage,
  decodeServerMessage,
  encodeMessage,
  type KickReason,
  LOADOUT,
  type MatchEndReason,
  type PlayerId,
  PlayerNameSchema,
  PROTOCOL_VERSION,
  SANDBOX_MAP,
  type ScoreEntry,
  type ServerMessage,
  type SnapshotPlayer,
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
type MatchEnd = Extract<ServerMessage, { type: "matchEnd" }>;
type Death = Extract<ServerMessage, { type: "death" }>;
type Snapshot = Extract<ServerMessage, { type: "snapshot" }>;

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
  dead: el("dead"),
  protected: el("protected"),
  killfeed: el("killfeed"),
  health: el("health"),
  ammo: el("ammo"),
  magazine: el("magazine"),
  reserve: el("reserve"),
  weapon: el("weapon"),
  scoreboard: el("scoreboard"),
  scoreboardReason: el("scoreboard-reason"),
  scores: el("scores"),
  nextRound: el("next-round"),
};

const END_TEXT: Record<MatchEndReason, string> = {
  killLimit: "Kill limit reached",
  timeLimit: "Time is up",
  closed: "Match closed",
};

const KICK_TEXT: Record<KickReason, string> = {
  host: "The host removed you from the lobby.",
  lobbyFull: "That lobby is full.",
  matchInProgress: "That match has already started — no late joining.",
  lobbyClosed: "The host closed the lobby.",
  protocolMismatch: "This client is a different version than the server. Reload the page.",
  invalidMessage: "The server rejected a message from this client.",
};

/** How long a killfeed line stays up, and how many are kept at once. */
const KILLFEED_SECONDS = 6;
const KILLFEED_LINES = 5;

let socket: WebSocket | null = null;
let current: LobbyState | null = null;
let match: Game | null = null;
/** From the last `matchStart`: what turns a countdown in ticks into one in seconds. */
let tickRateHz = 0;
/** The tick of the last snapshot, which is what a killfeed line is dated by. */
let lastTick = 0;
/** Set when the server names a reason, so the close handler does not overwrite it. */
let farewell: string | null = null;
/**
 * The killfeed, aged off by the tick a line arrived at rather than by a wall clock. The
 * server stops stepping while the host has the match paused, so a tick-aged line waits
 * behind the pause screen instead of expiring behind it — and there is no timer to cancel
 * when a round ends or the socket drops.
 */
let feed: ReadonlyArray<{ readonly tick: number; readonly node: HTMLLIElement }> = [];

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
      return `Scoreboard — ${seats} players, next match shortly`;
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

  // `waiting` is the one phase with no match under it. Reached from a fresh lobby, where
  // this does nothing, and from a restart the server refused for want of players — which
  // arrives as a phase and nothing else, so it is the only thing that can take the last
  // match off the screen.
  if (state.phase === "waiting") leaveMatch();

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
 *
 * A second `matchStart` is the next round after a scoreboard, on the same socket. The
 * running match is torn down rather than reused: it holds a spawn, a prediction and an
 * interpolation history belonging to a match that is over, and `startGame` takes all
 * three at construction.
 */
function enterMatch(message: MatchStart): void {
  const selfId = current?.selfId;
  if (selfId === undefined) return;
  match?.dispose();

  ui.game.hidden = false;
  ui.scoreboard.hidden = true;
  // The next round is a different match; last round's kills are not news in it.
  clearFeed();
  tickRateHz = message.tickRateHz;
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

/**
 * What the round flow has to say to the player it is happening to. Both come off the
 * snapshot rather than off a frame of their own, so they are right on the first one that
 * arrives and cannot be left stale by a message that went missing.
 */
function renderSelf(self: SnapshotPlayer | undefined, tick: number): void {
  ui.dead.hidden = self?.alive !== false;
  ui.protected.hidden = self?.spawnProtected !== true;

  if (self && !self.alive && self.respawnAtTick !== null && tickRateHz > 0) {
    // Rounded up, so the last second on screen is a second the player is still waiting.
    const seconds = Math.max(0, Math.ceil((self.respawnAtTick - tick) / tickRateHz));
    ui.dead.textContent = `Eliminated — back in ${seconds}`;
  }
}

const nameOf = (id: PlayerId | null): string | undefined =>
  current?.players.find((player) => player.id === id)?.name;

/**
 * One killfeed line. The names are joined here, from the last `lobbyState`, rather than
 * carried on the frame: the client already has the roster it is looking at, and the
 * scoreboard's rule fits a line just as well — anybody the lobby no longer has a name for
 * has left, and the line is dropped rather than printed against an id.
 */
function killLine(message: Death): HTMLLIElement | null {
  const killer = nameOf(message.killerId);
  const victim = nameOf(message.victimId);
  if (killer === undefined || victim === undefined) return null;

  const row = document.createElement("li");
  const weapon = document.createElement("span");
  weapon.className = "weapon";
  weapon.textContent = message.slot === null ? " — " : ` — ${LOADOUT[message.slot].name} — `;
  row.append(killer, weapon, victim);
  if (message.killerId === current?.selfId || message.victimId === current?.selfId) {
    row.classList.add("self");
  }
  return row;
}

/** Newest first, capped, and drawn from whatever is left. */
function showKill(message: Death, tick: number): void {
  const node = killLine(message);
  if (!node) return;
  feed = [{ tick, node }, ...feed].slice(0, KILLFEED_LINES);
  drawFeed();
}

/** Ages the feed against the tick the latest snapshot was taken at. */
function ageFeed(tick: number): void {
  const oldest = tick - KILLFEED_SECONDS * tickRateHz;
  const kept = feed.filter((line) => line.tick > oldest);
  if (kept.length === feed.length) return;
  feed = kept;
  drawFeed();
}

function drawFeed(): void {
  ui.killfeed.replaceChildren(...feed.map((line) => line.node));
}

function clearFeed(): void {
  feed = [];
  drawFeed();
}

/**
 * The hit marker, for the shooter alone — the server decides what a shot reached, and a
 * marker drawn on the local trigger pull would teach a player their aim was right on
 * shots that never landed.
 */
function flashHit(): void {
  ui.game.classList.remove("hit");
  // Reading a layout property is what restarts a CSS animation already part-way through.
  // Without it a second hit inside the first marker's 220 ms would draw nothing at all,
  // which at the SMG's rate is most of them.
  void ui.game.offsetWidth;
  ui.game.classList.add("hit");
}

/** Health at or below this reads as a warning rather than a number. */
const LOW_HEALTH = 30;

/**
 * Health, the weapon in hand and what is in it. The ammo comes off the snapshot, where
 * the server counts it; the weapon comes from the controls, where it is carried, because
 * the server is told which weapon fired on the frame that fired it and keeps no equipped
 * state of its own. That makes the name at most one tick stale after a switch, which is
 * the same tick everything else on this screen is.
 */
function renderHud(self: SnapshotPlayer | undefined, ammo: Snapshot["ammo"]): void {
  ui.health.hidden = self === undefined;
  ui.ammo.hidden = self === undefined;
  if (!self) return;

  ui.health.textContent = String(self.health);
  ui.health.classList.toggle("low", self.health <= LOW_HEALTH);

  const slot = match?.slot() ?? "primary";
  ui.weapon.textContent = LOADOUT[slot].name;

  const held = slot === "melee" || ammo === null ? null : ammo[slot];
  ui.magazine.hidden = held === null;
  ui.reserve.hidden = held === null;
  if (!held) return;
  ui.magazine.textContent = String(held.magazine);
  // A magazine at zero with rounds still in reserve is a reload in flight — the server
  // puts the fresh one in the moment its clock allows, so there is nothing else it can be.
  ui.reserve.textContent =
    held.magazine === 0 && held.reserve > 0 ? "reloading" : `/ ${held.reserve}`;
}

function scoreRow(entry: ScoreEntry): HTMLLIElement {
  const row = document.createElement("li");
  if (entry.id === current?.selfId) row.className = "self";

  const name = document.createElement("span");
  name.textContent = entry.name;
  const kills = document.createElement("b");
  kills.textContent = `${entry.score} k`;
  const deaths = document.createElement("b");
  deaths.textContent = `${entry.deaths} d`;
  row.append(name, kills, deaths);
  return row;
}

/** The scoreboard stays up until the next `matchStart` replaces it. */
function showScoreboard(message: MatchEnd): void {
  ui.dead.hidden = true;
  ui.protected.hidden = true;
  ui.health.hidden = true;
  ui.ammo.hidden = true;
  ui.scoreboard.hidden = false;
  ui.scoreboardReason.textContent = END_TEXT[message.reason];
  ui.scores.replaceChildren(...message.scores.map(scoreRow));
  ui.nextRound.textContent = "The next match starts shortly.";
  // The host's Close sits over the view, and the board is worth reading with a cursor.
  document.exitPointerLock?.();
}

/**
 * Everything the last match left on the screen. Without it the frozen view stays over
 * whatever is behind it, still eating the keyboard, and a scoreboard promising a next
 * match sits over a lobby that is waiting for players.
 */
function leaveMatch(): void {
  match?.dispose();
  match = null;
  clearFeed();
  ui.game.classList.remove("hit");
  ui.health.hidden = true;
  ui.ammo.hidden = true;
  ui.game.hidden = true;
  ui.dead.hidden = true;
  ui.protected.hidden = true;
  ui.scoreboard.hidden = true;
}

function showJoinScreen(message: string): void {
  socket = null;
  current = null;
  leaveMatch();
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
      case "snapshot": {
        match?.snapshot(message);
        lastTick = message.tick;
        renderSelf(
          message.players.find((player) => player.id === current?.selfId),
          message.tick,
        );
        renderHud(
          message.players.find((player) => player.id === current?.selfId),
          message.ammo,
        );
        ageFeed(message.tick);
        break;
      }
      case "hit":
        if (message.shooterId === current?.selfId) flashHit();
        break;
      case "death":
        // Dated by the last tick this client knows about — the snapshot for the tick the
        // kill happened on is already in hand, because the server sends it first.
        showKill(message, lastTick);
        break;
      case "matchEnd":
        showScoreboard(message);
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

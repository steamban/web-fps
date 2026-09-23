# web-fps — Implementation Plan

Browser FPS, arcade style (krunker/ev/venge-like), LAN/Tailscale-hostable. v1 scope only — see "Deferred" at the bottom for v2+.

## Decisions

| Area | Decision |
|---|---|
| Language | TypeScript, built TDD (red-green-refactor, tests before logic) |
| Client render | Three.js, low-poly flat-shaded geometry (no texture pipeline needed) |
| Server | Node.js, authoritative (server resolves movement + hits), no anti-cheat |
| Networking | WebSocket, server-authoritative state, client-side prediction + interpolation for smoothness |
| Hosting | Docker, dev-mode (volume mount + live reload), bind `0.0.0.0`, port published — reachable via LAN IP or Tailscale IP |
| Game mode | Free-for-all deathmatch, 1 map, 2-8 players |
| Weapons | Primary + secondary + melee, hitscan, identical loadout for all players |
| Movement | WASD + jump only, hand-rolled AABB/capsule collision |
| Round | 30 kills or 10 min (first hit), 5s respawn timer, 5s spawn protection, scoreboard → auto-restart same map |
| Lobby | First joiner = host (Start/Kick/Pause/Close controls), no late-join once started |

## Repo structure

npm workspaces monorepo — one repo, one `docker compose up` for dev.

```
csgo-web/
  packages/
    shared/       # types + constants shared by client & server (network protocol, weapon stats, map data)
    server/       # Node WS server: lobby, authoritative sim, hit resolution
    client/       # Three.js browser client: render, input, prediction/interpolation
  docker-compose.yml
  package.json    # workspaces root
```

`shared` exists so the network protocol is one set of TypeScript types both sides import — a renamed/retyped field fails to compile instead of failing silently at runtime.

## Configuration (env vars)

Gameplay/session tunables are env-configurable so you can retune without touching code. Scoped to session-shape numbers (limits, timers, capacity) — per-weapon balance stats (damage, fire rate) stay as data in `shared`, not env vars, since exploding every weapon number into an env var is config sprawl for no real benefit at this scale.

| Var | Default | Meaning |
|---|---|---|
| `SERVER_PORT` | `8080` | WS/HTTP listen port |
| `TICK_RATE_HZ` | `20` | Server simulation rate |
| `MIN_PLAYERS` | `2` | Host can't Start below this (bypassed in dev mode) |
| `MAX_PLAYERS` | `8` | Lobby capacity |
| `KILL_LIMIT` | `30` | Match ends at this score |
| `TIME_LIMIT_MINUTES` | `10` | Match ends at this clock time |
| `RESPAWN_SECONDS` | `5` | Death → respawn delay |
| `SPAWN_PROTECTION_SECONDS` | `5` | Post-respawn invulnerability |
| `GAME_MODE` | `player` | `dev` \| `player` — see below |

All read through one `packages/server/src/config.ts`: parses `process.env` once at boot, applies defaults, validates ranges (e.g. `MIN_PLAYERS <= MAX_PLAYERS`, all numerics positive), and exports a single typed `Config` object. Fail fast — invalid config crashes on startup with a clear message, not at some random point mid-match. Nothing outside this module touches `process.env` directly.

**`GAME_MODE=dev` vs `player`** — a behavior toggle, not a balance toggle (balance is already covered by the vars above, so this doesn't duplicate that):
- `dev`: debug HUD overlay (FPS, ping, tick counter, hitbox wireframes), verbose server logging, host can Start solo (skips `MIN_PLAYERS` check) so you can playtest movement/combat alone
- `player`: none of the above — the normal experience for an actual LAN party

## Network protocol (sketch, lives in `packages/shared`)

Client → Server: `join`, `input` (movement keys + look angle, sent per tick), `fire`, `pause` (host only), `kick` (host only), `start` (host only), `close` (host only)

Server → Client: `lobbyState`, `matchStart`, `snapshot` (positions/health/etc, sent per tick), `hit`, `death`, `respawn`, `matchEnd`, `kicked`

Tick rate: 20Hz server simulation to start — bump if movement feels choppy on LAN (latency is near-zero, so headroom is in CPU, not network).

## Milestones

Each milestone ends in something you can run and see working. TDD means: for M2 onward, write the test for a behavior (e.g. "player stops at a wall") before the code that makes it pass.

**M0 — Scaffold**
- npm workspaces, TS config, lint/format, Vitest for `shared`/`server`, a browser-friendly test runner for `client` logic that doesn't touch Three.js/WebGL directly
- `packages/shared`: protocol message types, weapon stats constants, map data shape, Zod schemas for wire messages
- `packages/server/src/config.ts`: env var parsing/validation (see Configuration section) — build this before anything reads a tunable
- Empty Docker dev setup that boots the server workspace with live reload

**M1 — Lobby & connection**
- Server: WS connection handling, lobby state machine (waiting → in-progress → paused → ended), first-connect = host
- Host actions: Start, Kick, Pause, Close — tested as server-side state transitions first, no UI yet (`Start` enforces `MIN_PLAYERS` unless `GAME_MODE=dev`)
- Client: bare join screen (enter host IP:port), shows connected players, host sees control buttons
- Test: multiple simulated clients join/leave, host-only actions rejected from non-host

**M2 — Single-player movement sandbox**
- One static low-poly test map (boxes/ramps) rendered in Three.js
- WASD + jump + hand-rolled AABB collision, no networking yet — get movement feel right against a mock/local loop first
- Tests: collision resolution against walls/floor/ramp edge cases (corner clipping, standing on edge, jump apex)

**M3 — Multiplayer sync**
- Server becomes authoritative: clients send `input`, server simulates all players, broadcasts `snapshot`
- Client: renders other players from snapshots with interpolation; predicts local player then reconciles against server snapshot
- Test: server sim is deterministic given the same input sequence (pure function of state + input → state), so it's testable without sockets

**M4 — Combat**
- Weapon loadout (primary/secondary/melee), hitscan raycast resolved server-side against player hitboxes
- Damage, health, death
- Test: hitscan ray vs known player positions → correct hit/miss and damage, resolved server-side only (client never decides a kill)

**M5 — Round flow**
- Respawn timer (5s) + spawn protection (5s), win condition (30 kills / 10 min), scoreboard screen, auto-restart
- Test: round state machine — kill count and clock both independently trigger match end; spawn protection expires and re-enables damage

**M6 — HUD & feedback**
- Health/ammo, crosshair, killfeed, scoreboard overlay, basic SFX (gunshot, footsteps, hit marker)
- Debug overlay (FPS, ping, tick, hitbox wireframes) gated behind `GAME_MODE=dev`
- No test-first here — this is view layer, verify by playing

**M7 — Docker packaging pass**
- Confirm `docker compose up` on a clean machine: server binds `0.0.0.0`, port published, client served (static build or same dev server), reachable from a second PC on LAN and over Tailscale
- Manual test: two real machines, one as host, join via LAN IP and via Tailscale IP

## Technical details

Finer-grained practices worth locking in now, since they're much cheaper to follow from M0 than to retrofit after M3.

**Config as a single boundary.** `config.ts` (above) is the only file that reads `process.env`. Every other module receives config values as constructor/function arguments. This is the general rule, not just for env vars: validate at system boundaries (env, network input, in M4 the fire-ray input) and trust internal calls beyond that — don't re-validate a value five functions deep that was already validated at the edge.

**Server simulation as a pure reducer.** The authoritative sim is `simulate(state: GameState, inputs: PlayerInput[], dtMs: number): GameState` — a pure function with no I/O, no `Date.now()`, no socket access. The WS layer is a thin shell around it: collect inputs → call `simulate` → broadcast the resulting snapshot. This is what makes M2-M5 testable without spinning up sockets: feed known state + input sequences in, assert the resulting state, no mocks needed. Side effects (sending packets, logging) live only in the shell, never inside `simulate`.

**Fixed timestep loop.** The server steps `simulate` on a fixed interval (`1000 / TICK_RATE_HZ`), independent of how often network I/O happens to fire. Don't drive simulation off "whenever a message arrives" — that makes match behavior depend on network jitter, which defeats the purpose of an authoritative server.

**Client-side prediction + reconciliation** (standard FPS netcode, needed for the "smooth" requirement even on low-latency LAN):
1. Client applies its own input to local state immediately using the *same* `simulate` function from `shared`, and renders that — no waiting for the server round-trip.
2. Every input sent to the server carries an incrementing sequence number; the client keeps a short ring buffer of `{seq, input}` it hasn't yet seen acknowledged.
3. On each server snapshot (which echoes the last-processed seq for that player), the client discards acked inputs from the buffer, snaps to the server's authoritative state, then replays the remaining unacked inputs on top — so a brief server round-trip doesn't feel like rubber-banding.
4. Remote players (not the local client) are never predicted — they're rendered via interpolation between the last two received snapshots, deliberately ~1 tick behind, to smooth over tick-rate vs. render-rate mismatch.

**Hitscan resolution, explicitly.** On `fire`, the server raycasts using *that player's server-known position/orientation at the current tick* — no rewind/lag-compensation buffer. This is a deliberate simplification riding on the earlier decision (LAN-only, near-zero latency): flag it as the ceiling if this project ever leaves LAN play — add a rewind buffer (store last ~200ms of player transforms, rewind to the shooter's claimed timestamp before raycasting) if internet play is ever added.

**Runtime validation at the network edge.** TypeScript types are erased at compile time, so a WS message is `unknown` until checked — a malicious or buggy client can send anything. Every incoming message is parsed through a runtime schema (Zod, defined in `shared` alongside the message types so the compile-time type and the runtime check can't drift apart) before touching game state. Malformed messages are dropped and logged, not trusted.

**Dependency direction.** `shared` depends on nothing in this repo. `server` depends only on `shared`. `client` depends only on `shared`. Neither `server` nor `client` ever imports from each other — the only thing that crosses that boundary is the wire protocol. This keeps the server deployable/testable with zero knowledge of Three.js, and stops "just import the server's player type" shortcuts that quietly couple the two.

**Test pyramid.** Heavy on unit tests for pure logic with zero I/O: `simulate`, collision resolution, hitscan-vs-hitbox, round state machine, config validation. A thin layer of integration tests spins up a real in-process WS server + client to cover message flows that are inherently stateful across a connection (join → lobby state → start → snapshot flow, kick, reconnect-rejection). No browser/e2e automation for v1 — render/feel is verified by playing (per M6/M7), which is cheaper than building visual test infra for a project this size.

## Deferred (explicitly out of scope for v1)

- Team deathmatch (v2)
- Bunny-hop/air-strafe movement tech (v2)
- CS-style bomb-defusal mode (v3+)
- Anti-cheat, late-join/reconnect, matchmaking/auto-discovery, minimap, multiple maps

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

## Working agreement

Process rules that hold across every milestone. A milestone may be picked up in a different
session than the one that started it, so these are written down rather than assumed.

**Commit atomically, as you go.** One commit per coherent change — never one commit per
milestone. A commit is atomic when it stands on its own: it makes one change, it can be
reverted without collateral, and `npm test`, `npm run lint` and `npm run typecheck` all pass
*at that commit*. Tests ship in the same commit as the code they cover. A new dependency
lands in the commit that first needs it, not in a batch ahead of time.

**Conventional Commits.** `type(scope): subject` — imperative mood, lowercase subject, no
trailing period.

| | |
|---|---|
| type | `feat` `fix` `test` `refactor` `docs` `build` `chore` |
| scope | `shared` `server` `client`, or omitted when the change is repo-wide |

**A fix for a bug that was never committed belongs in the commit that introduces the code**,
not in a separate `fix:`. A `fix:` commit asserts that a defect once shipped; reserve it for
bugs that really are in the history.

M1 was built as one large uncommitted change and only split afterwards — a one-off, not the
pattern. What it was split into is what the history should have looked like from the start:

```
fix(shared): allow a zero-width joiner in player names
feat(shared): add the websocket path to the protocol
feat(server): add lobby state machine
feat(server): serve the lobby over websocket
feat(client): parse the host address a player types
feat(client): add join screen and lobby view
docs: describe the lobby in the readme
docs: add a working agreement and design log to the plan
```

The zero-width-joiner bug was in `shared` since M0, so it is a real `fix:`. The join screen's
superseded-connection bug was found before any of that code was committed, so its fix lives
inside `feat(client): add join screen and lobby view` rather than trailing it.

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

## Design log

Decisions taken *while implementing* a milestone that are not derivable from the code and are
not already written above. Each milestone may be a different session, so a reason that lives
only in someone's head is lost — read this section before starting a milestone, and append to
it in the same commit that makes the decision. Record the call, why it was made, and where one
exists, the condition that would reverse it.

### M0 — Scaffold

- **TypeScript type-checks; it never emits.** `module: preserve` + `noEmit` across every
  package, with `tsx` running the server and vite the client, both resolving TypeScript from
  source. Consequence: relative imports carry no `.js` extension anywhere.
- **Workspace packages export raw `src/index.ts`.** No build step before dev and no `dist/`
  to go stale. Reverse this if `shared` is ever published or consumed from plain Node — that
  needs a real build with type declarations.
- **Wire types are inferred from the Zod schemas, never declared alongside them.** A
  hand-written type can drift from the schema that validates it; `z.infer` cannot.
- **An empty environment variable means unset.** Docker and shell exports both surface
  "unset" as an empty string, so `SERVER_PORT=` has to mean the default rather than `0`.
- **Docker mounts only `packages/*/src`.** Dependencies stay exactly as the image installed
  them, so there is no anonymous volume to go stale — at the cost of needing
  `docker compose up --build` after a dependency change.

### M1 — Lobby & connection

- **The lobby is a pure reducer returning `{ state, effects }`;** `net.ts` is the only file
  that touches sockets. `sync` is an effect rather than a pre-built message because
  `lobbyState` carries a per-recipient `selfId`. The same split is planned for `simulate()`
  in M3, and is what lets the transitions be tested without mocks.
- **`hostId` is derived from `members[0]`, not stored.** Join order is host order, so
  promotion after a departure is implicit and there is no second field that can drift.
- **`close` resets to a fresh `waiting` lobby** instead of parking the state in `ended`.
  Parking there would leave the server unusable until a restart. M5 introduces `ended`
  properly, together with the scoreboard and auto-restart.
- **`start` only flips the phase.** `matchStart` carries map data, which does not exist until
  M2 — until then clients learn the match began from `lobbyState.phase`.
- **`lobbyState.minPlayers` reports the *effective* minimum** — 1 under `GAME_MODE=dev`,
  where a host may start solo. This lets the client gate its own Start button without
  knowing that game modes exist.
- **Host-only actions from a non-host are dropped silently, not answered.** The server is the
  authority; the client disables the control from the last `lobbyState`, so a rejected click
  means a stale view rather than something worth a reply.
- **Player ids are server-assigned UUIDs, issued on connect rather than on join.** A joiner
  who is refused — lobby full, match already running — still needs an address to receive
  `kicked` at.
- **A protocol mismatch is re-derived in `net.ts` after decoding fails.**
  `decodeClientMessage` returns `null` for both a malformed frame and a stale
  `protocolVersion`; telling a half-updated LAN party "reload the page" is worth a second
  `JSON.parse` on the failure path.
- **`ws` is a dependency because Node ships a WebSocket client but no server.** Its 15s
  ping/pong heartbeat exists so a half-open socket cannot sit on a lobby seat forever.
- **Client logic is tested under happy-dom against the real `index.html`** (imported with
  vite's `?raw`), so a renamed element id fails a test instead of the browser. Added after a
  join-screen bug survived 107 passing tests.

### M2 — Single-player movement sandbox

- **Collision is two modules: `collision.ts` is geometry, `movement.ts` is tuning.** The
  resolver takes a box and a delta and knows nothing about gravity, input or how wide a
  player is; speeds and player dimensions live one layer up. M3 needs the same resolver on
  the server, and this is what stops the server pulling in client feel constants.
- **Per-axis resolution with substepping, not swept collision.** Moving and resolving x,
  then z, then y is what makes a player slide along an angled wall and what stops a diagonal
  run squeezing through an inside corner. Its weakness is over-travel within a single step,
  so a move longer than 0.1 m is split into several. That bound is well under the thinnest
  geometry a map uses, so nothing tunnels — a 20 m/s fall at 20 Hz becomes ten substeps.
  Revisit only if the substep count ever shows up in a profile.
- **Ramps are height fields, not solids.** A ramp contributes a floor height over its
  footprint rather than faces to collide with. The player is carried by whichever corner of
  their footprint is furthest uphill: going up that is the leading edge, so they can never
  clip into the slope; coming down it is the trailing edge, so they stay supported.
  A rise within `stepHeight` lifts the player; a taller one blocks like a wall, which is
  what makes a ramp's tall face solid without describing it separately.
- **A ramp has no underside.** Nothing collides with a slope from below. True while every
  ramp in a map sits on the floor; a map that suspends one would need real wedge collision.
- **Yaw 0 faces -z, and `movement.ts` is where that is written down.** It matches a
  Three.js camera's resting direction, so the renderer needs no conversion. Forward is
  `(-sin yaw, 0, -cos yaw)`; spawn yaws in map data mean the same thing.
- **Horizontal velocity tracks the keys instantly, in the air as on the ground.** No
  acceleration curve, no friction, no air-control penalty — arcade, and the movement tech
  those would enable is already deferred to v2. It also means only `velocity.y` has to
  carry between steps, which keeps reconciliation in M3 to a single number.
- **Jump and ground-snap are mutually exclusive.** Snapping applies only to a player who
  was grounded and is not leaving the ground this step; applied during a jump it would glue
  them back to the floor.
- **`stepMovement` takes `dtMs` rather than assuming the tick rate.** The sandbox runs it
  at 60 Hz for feel; M3's server will run it at `TICK_RATE_HZ`. The caller owns the rate.
- **Ground snapping on descent.** After a move that would leave a grounded player airborne,
  they are pulled back down onto anything within `stepHeight`. Without it, walking down a
  slope is a series of little hops, because a step forward drops the floor out from under
  the player faster than gravity takes them to it.

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

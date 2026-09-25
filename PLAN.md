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
- **The arena's floor, ceiling and outer walls are the play-area bounds, not boxes.**
  `bounds` is the shell and everything in `boxes` is something standing inside it, so there
  is one clamp instead of six walls to keep consistent — and the renderer draws the same
  shell from the same numbers.
- **The map is a typed constant in `shared`, not a JSON asset.** A coordinate typo is a
  compile error, and M3 ships this exact object in `matchStart`, so what the server
  simulates and what the client draws cannot diverge. Loading maps from files is only worth
  it once there is more than one, which v1 has already deferred.
- **Ramps are drawn as a box whose four top corners are placed by `rampSurfaceHeight`.**
  The two corners on the low edge collapse onto their own bottom corners, which turns the
  box into the wedge for the price of two zero-area triangles. Cheaper than a special-cased
  wedge, and it makes the visible slope literally the collision surface — the one client
  bug this milestone could most easily ship is a ramp you can see but not stand on, so
  that is the one renderer behaviour with a test.
- **The renderer has no `dist` of its own map.** `buildScene` takes `MapData` and nothing
  else, so the M3 client will draw whatever `matchStart` hands it without a second path.
- **Controls split into pure angle maths and listener plumbing.** `applyLook` and
  `keyField` are functions with tests; `createControls` is the wiring around them. The bugs
  this code actually has — a key that sticks after the window loses focus, a mouse that
  turns the view when the pointer is not locked — are in the wiring, so that is covered
  through real events rather than mocked out.
- **Movement keys are read from `event.code`, by physical position.** WASD stays where the
  fingers are whatever the keyboard layout is.
- **The sandbox loop runs at 60 Hz, not the server's 20 Hz.** It has no interpolation, so
  stepping at the tick rate would mean judging the movement through a stutter that M3's
  interpolation removes. The physics is what is being tuned here; `stepMovement` takes its
  dt, so M3 drives the same code at `TICK_RATE_HZ` without either side changing. A
  backgrounded tab returns with a huge elapsed time, so catch-up is capped at 250 ms rather
  than freezing while the loop works through it.
- **The sandbox is a button on the join screen, and leaving it is a reload.** It needs no
  server, so it does not belong behind one; and it is a tuning tool, not a screen the lobby
  navigates back and forth to, so there is no teardown path to keep correct.
- **The resolver has a contact tolerance, and it is load-bearing.** A resolved move parks
  the player exactly on the face they hit, but movement stores a position and rebuilds the
  box from it next step, and that round trip is not exact — so resting on something comes
  back as a penetration around 1e-15 deep. Treated as a collision, that fires on *every*
  axis, including the ones the player is only sliding along, and the push-out then ejects
  them the full width of whatever they were leaning on: measured teleports of 0.3-6.5 m
  from a standing start, on 26 of 312 sampled approaches across the sandbox map. Overlaps
  below a nanometre are therefore contact, not collision. Do not remove this in the belief
  that exact arithmetic makes it unnecessary; it is exactly the exactness that fails.
- **An axis with no movement is not resolved at all.** Per-axis resolution reads the exit
  direction off the sign of the move, so an axis moved by zero has no sign to read and
  would push everything the same way. A move of zero cannot have entered anything, so any
  overlap it finds predates it and is not its to undo.
- **Only ramps carry a player up; a box is always jumped or gone around.** `stepHeight`
  is a slope limit, not a stair height — `moveHorizontal` pushes out of every box
  regardless of how low it is. Boxes that step up would mean mounting cover by walking at
  it, which is not the arcade feel this is after. The sandbox map's comments were written
  the other way round at first and had to be corrected; the behaviour has a test now so the
  next reader is not misled again.
- **The jump apex depends on the tick rate, so map heights are judged at the slowest one.**
  The arc is integrated a step at a time, which peaks lower the coarser the step: 0.99 m at
  the server's default 20 Hz, 1.11 m at the sandbox's 60, 1.14 m at 120. A box top between
  those is one a player mounts while tuning and cannot mount in a match. No obstacle height
  is allowed to sit in that band, and a test enforces it against the real jump rather than
  a copied number. Removing the dependence would mean integrating the arc analytically —
  worth it only if a tunable ever lands in that band for a good reason.
- **Ground snapping on descent.** After a move that would leave a grounded player airborne,
  they are pulled back down onto anything within `stepHeight`. Without it, walking down a
  slope is a series of little hops, because a step forward drops the floor out from under
  the player faster than gravity takes them to it.

### M3 — Multiplayer sync

- **`simulate` lives in `server`, not `shared`; only the movement step is shared.** The
  plan's Technical details said the client predicts with "the same `simulate` from
  `shared`", but the same section also says remote players are never predicted — and a
  client calling a whole-`GameState` fold would predict them. The client predicts itself
  by calling `stepMovement` directly, which is the same function the server's fold calls
  with the same arguments, so the two agree without `shared` holding a function with one
  caller. Move it only if the client ever needs to simulate somebody else.
- **`simulate` folds over the players, never over the inputs.** Gravity only advances
  inside a step, so a player whose input frame was late or dropped has to be stepped
  anyway or they hang in the air until they send something. Their keys are released for
  that tick rather than repeated: repeating walks them into geometry the server was never
  asked to walk them into.
- **A tick applies every input queued for a player, in order, one step each — not the
  newest.** Both sides step at the tick rate off unsynchronised clocks, so their phases
  drift and two input frames periodically land inside one tick. Dropping one leaves the
  server permanently a step behind an input the client has already discarded as
  acknowledged, and the correction is visible: 0.35 m at the default speed and tick rate,
  in the same direction for long stretches. The cost is that a client sending faster than
  the tick rate moves faster, bounded by the queue cap; v1 has no anti-cheat, so that is
  accepted rather than solved.
- **`ackSeq` is set inside the step, to the last sequence number actually applied.** The
  natural shell-side implementation — remember the newest input received, read it when
  broadcasting — acknowledges an input that arrived *after* the step, so the client drops
  a prediction whose motion the snapshot does not contain. Off by one input, every tick.
- **A sequence number at or below what has already been simulated is skipped, and that is
  what makes `ackSeq: 0` unambiguous.** Tightening the schema to reject seq 0 was the
  obvious alternative and is worse: a schema failure closes the socket, so it turns a
  harmless value into a mid-match disconnect, and it is blind to the replay the guard also
  covers (5, 5, 3 are all positive). The client starts at 1 as a convention, not a rule.
- **The snapshot carries `velocityY` and `grounded` beside `position`.** That is exactly
  what a movement step carries between ticks — horizontal velocity is re-derived from the
  keys every step — so it is the closure of what a replay needs and nothing more. Not the
  whole velocity vector, which would publish two derived numbers a future reader would
  trust; not a separate self-only block, which buys a few hundred bytes a second on a LAN
  in exchange for a second message shape and a new invariant.
- **`matchStart` carries the recipient's own spawn, and so is sent per recipient.** The
  map's spawn yaws exist to turn each corner towards the middle, and nothing else tells a
  client which spawn it got: the snapshot's yaw is only an echo of what that client last
  sent, so its first input would overwrite the server's spawn yaw before anything was
  drawn. Same shape as `lobbyStateFor`.
- **Yaw is folded onto one turn where an input enters the state.** `protocol.ts` already
  promised this and nothing did it. It is a trust boundary: yaw is unbounded on the wire,
  and a finite but enormous value overflows the difference the client takes to interpolate
  a facing, putting `NaN` into another player's mesh rotation. The counter-argument is
  that the interpolator has to wrap its delta regardless — true, and it still does, since
  two angles inside one turn can still straddle the seam. Neither replaces the other.
- **One `wrapAngle`, written as `atan2(sin, cos)`.** The usual subtract-a-multiple-of-a-turn
  form is cheaper but returns rubbish near `Number.MAX_VALUE`, where the subtraction is
  all rounding error — which is precisely the input this has to survive. `controls.ts`
  dropped its own copy for it.
- **Whether a match exists is derived from the lobby phase at the end of every transition,
  not raised as an effect.** `leave` on the last member resets to a fresh lobby with *no
  effects at all*, so an effect-driven teardown misses exactly the case that matters and
  leaves a match ticking against nobody, with a second timer stacked on the next one. The
  same evaluation drops departed players from the simulation; it never inserts, because a
  join is refused once a match is running.
- **Input outside a running match is dropped, silently.** Not queued — holding frames
  through a pause bursts the backlog into the tick that resumes it, which is a teleport.
  Not rejected either: a client whose loop starts a tick early is not one to disconnect.
- **The input queue is capped at the client's permitted catch-up.** A backgrounded tab
  returns owing up to `MAX_CATCHUP_MS` of steps and releases them at once, so anything
  smaller clips a legitimate burst. The constant lives in `shared` because both sides
  size themselves from it.
- **Spawns are assigned once, at match start, and pinned into the state.** An index into
  the member list would shift the moment somebody left, teleporting everyone still
  playing. The sandbox map grew to one spawn per lobby seat for the same reason players
  cannot be stacked: nothing collides two players with each other.
- **The client enters a match on `matchStart` only, and leaves only when the socket
  closes.** A mid-match departure re-syncs the lobby to everyone still in it, so entering
  on `lobbyState.phase` would rebuild the renderer on every quit. And there is no
  transition in which a connected client sees the phase leave `inProgress` — `close`
  disconnects everybody — so a phase-driven exit would be dead code guarding the one path
  that is real. Teardown lives in `showJoinScreen`, which every disconnect already goes
  through.
- **Aim is drawn at the frame rate; position is drawn between the last two predicted
  steps.** Rendering the raw predicted state at 20 Hz holds the view still for two frames
  and then moves it a third of a metre, which reads as a stutter; interpolating costs at
  most one step of positional lag and none at all on the aim, which is where lag is felt.
  The previous position is captured inside the step loop, not before it, or a frame that
  runs two steps draws the camera at half speed; and a correction sets both, or the camera
  sweeps through it over the following step — backwards, when the correction was.
- **`reconcile` takes no local state.** A correction starts from the server's word by
  definition, so the same call that handles the steady state also builds the very first
  one — no `if (first)` branch, and no second place a `MovementState` is constructed.
  Replay uses the yaw each input was *sent* with, because that is what the server ran it
  with; the live camera yaw would predict a path nobody simulated.
- **Remote players are interpolated from the last two snapshots and their arrival times,
  with the fraction clamped.** Clamping is what makes a stall freeze them where they were
  last seen instead of sliding them through walls. The drawing is driven by the newest
  snapshot, so a player who has gone stops being drawn at once and one who has just
  arrived is drawn where they are rather than streaking in from the origin.
- **The pending-input buffer is not capped.** It only grows while the client is stepping
  and unacknowledged, and it stops stepping when the match is not running; the 15 s socket
  heartbeat bounds everything else. Replaying a few hundred steps is milliseconds, so a
  cap here would be code that cannot run.
- **A tapped jump is latched; the movement keys are not.** A step is a tick in a match, so
  a press and release inside 50 ms is invisible in the held state — well inside what a
  player does, and something the sandbox's 60 Hz loop could never reproduce. Latching a
  direction instead would turn a tap into a whole step of travel.
- **The renderer rig is shared by the sandbox and a match, the loops are not.** The
  sandbox exists to judge how a match feels, so a different field of view would make the
  tuning a lie. The loops stay apart because one is shaped by a server — a step is a tick,
  and what is drawn is a prediction being corrected — and the other has nothing to be
  corrected by.
- **The host's controls are lifted out of the layout the game view covers.** Otherwise the
  only way to end a running match is a reload, which drops the host from the lobby, hands
  it to somebody else and leaves the match running. Pinned to a corner rather than left
  centred, where they would sit under the crosshair and catch the click that recaptures
  the mouse.

## Technical details

Finer-grained practices worth locking in now, since they're much cheaper to follow from M0 than to retrofit after M3.

**Config as a single boundary.** `config.ts` (above) is the only file that reads `process.env`. Every other module receives config values as constructor/function arguments. This is the general rule, not just for env vars: validate at system boundaries (env, network input, in M4 the fire-ray input) and trust internal calls beyond that — don't re-validate a value five functions deep that was already validated at the edge.

**Server simulation as a pure reducer.** The authoritative sim is `simulate(state: GameState, inputs: PlayerInput[], dtMs: number): GameState` — a pure function with no I/O, no `Date.now()`, no socket access. The WS layer is a thin shell around it: collect inputs → call `simulate` → broadcast the resulting snapshot. This is what makes M2-M5 testable without spinning up sockets: feed known state + input sequences in, assert the resulting state, no mocks needed. Side effects (sending packets, logging) live only in the shell, never inside `simulate`.

**Fixed timestep loop.** The server steps `simulate` on a fixed interval (`1000 / TICK_RATE_HZ`), independent of how often network I/O happens to fire. Don't drive simulation off "whenever a message arrives" — that makes match behavior depend on network jitter, which defeats the purpose of an authoritative server.

**Client-side prediction + reconciliation** (standard FPS netcode, needed for the "smooth" requirement even on low-latency LAN):
1. Client applies its own input to local state immediately using the *same* movement step from `shared` that the server's `simulate` folds over every player, and renders that — no waiting for the server round-trip. (Written as "the same `simulate` from `shared`" before M3; see the M3 design log for why only the step itself is shared.)
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

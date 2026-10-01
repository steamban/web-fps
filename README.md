# web-fps

Browser FPS, arcade style — server-authoritative, LAN/Tailscale-hostable, free-for-all deathmatch.

Full design and milestone breakdown: [PLAN.md](./PLAN.md).

## Status

**M6 — HUD & feedback.** The match now tells you what is happening in it. A crosshair,
health and the rounds left in the bottom corners, a killfeed in the top right, a marker
on the crosshair when one of your shots lands, and the scores on Tab without leaving the
round. Every weapon has a magazine, a reserve and a reload: a round leaves the magazine
on each shot, the one that empties it starts the reload, and it is full again when the
clock says so — a trigger pulled on an empty gun does nothing at all.

The sound is synthesised rather than loaded, so the repo still ships no binary assets:
gunshots, footsteps, a landing thud and a hit marker, with everybody else's placed where
they are standing and your own heard flat and immediately.

`GAME_MODE=dev` adds an overlay with the frame rate, the tick, the latency from an input
leaving the client to the snapshot that acknowledges it, and a wireframe of the hitbox
the server actually raycasts — which is axis-aligned, while the body you see is turned to
face the way that player is looking.

A round still plays itself out as M5 left it: the server raycasts each shot from where
the tick left the shooter, a player at zero health comes back after `RESPAWN_SECONDS` at
the spawn furthest from anyone alive and briefly unshootable, and the round ends at
`KILL_LIMIT` kills or `TIME_LIMIT_MINUTES`, whichever comes first.

There is no head hitbox and there will not be one in v1 — see the M6 design log for the
arithmetic. Left for M7: a packaging pass on two real machines.

## Layout

```
packages/
  shared/   wire protocol, weapon stats, map data and the sandbox map, collision + movement
  server/   Node server: config boundary, HTTP/WS host, lobby state machine, authoritative sim
  client/   Vite browser client: join screen, lobby, netcode, Three.js renderer and the loops
```

`shared` depends on nothing in this repo; `server` and `client` each depend only on
`shared` and never on each other. The only thing crossing that boundary is the wire protocol.

## Running it

With Docker — the way it is meant to be hosted:

```bash
docker compose up --build
curl http://localhost:8080/health
```

That builds the client into the image and serves it from the same port the game socket
is on, so there is one address to hand around. The server binds `0.0.0.0` and the port is
published, so everyone else opens `http://<your-lan-ip>:8080` or
`http://<your-tailscale-ip>:8080`, types a name and presses Join — the address field is
already filled in with the host they reached the page on.

Pass `--build` every time. The image contains the built client and the installed
dependencies, so a plain `docker compose up` happily reuses one built before either
changed; rebuilding is a cache hit when nothing has, so there is no reason not to.

To edit the server inside the container instead, with the source bind-mounted and
reloading in place:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

That one serves no client — run the Vite dev server for it, as below.

Without Docker:

```bash
npm install
npm run dev          # server on :8080
npm run dev:client   # client on :5173
```

Open `http://localhost:5173`, type the server's `host:port` (the port alone defaults to
`8080`) and a name. The dev server is not the game server, so here the address is typed
rather than filled in. The first person to join hosts and gets the lobby controls; everyone
else sees the player list. Open a second browser tab to play both sides — or set
`GAME_MODE=dev` to start a match on your own.

Once the host presses Start you are in the map: click to capture the mouse, WASD and
Space to move, click to fire, 1, 2 and 3 to switch between the SMG, the pistol and the
knife, Tab to see the scores, Esc to release the mouse. The host keeps Pause and Close in
the top-right corner.

**Movement sandbox** — the button under Join. It needs no server at all: it drops you into
the map alone so the movement can be tuned without a network round trip in the way. Click
to capture the mouse, WASD to move, Space to jump, Esc to release it.

The lobby lives entirely in [`packages/server/src/lobby.ts`](./packages/server/src/lobby.ts)
as pure `(state, args) -> { state, effects }` transitions, and the match in
[`simulation.ts`](./packages/server/src/simulation.ts) as `simulate(state, inputs, dt)`
with no clock and no sockets in it. [`net.ts`](./packages/server/src/net.ts) is the shell
that owns both of those things and carries the effects out. That split is what lets every
transition and every tick be proved by calling a function.

The round flow is split the same way. `simulate` answers whether a match is over
(`matchOutcome`) and what the scoreboard says (`matchEndMessage`) as questions about a
state; `lobby.ts` owns the `ended` phase the scoreboard lives in; and `net.ts` owns the
one thing neither can, the timer between one round and the next. The limits themselves
are quantised into ticks once, at kickoff, and pinned onto the match — the simulation has
no clock but its own tick counter, which is also why a paused match burns none of it.

Combat follows the same split. [`combat.ts`](./packages/server/src/combat.ts) owns every
rule a client must not decide — who is hittable, what a weapon reaches, what it costs and
who gets the credit — and the geometry it asks is a ray against the same map data
movement collides with. Shots are resolved after movement, against the state the tick
left behind, so two players who shoot each other in the same tick both die.

Movement is the same idea. [`collision.ts`](./packages/shared/src/collision.ts) moves a box
through map geometry and knows nothing else;
[`movement.ts`](./packages/shared/src/movement.ts) owns the speeds, the jump and the player's
size and calls it. Both are pure and live in `shared`, so the client predicting a step and
the server deciding it run the identical code — with the identical timestep, which is what
makes a prediction something the server can agree with rather than correct forever.

The client is split the same way: [`netcode.ts`](./packages/client/src/netcode.ts) is the
reconciliation and interpolation maths, tested on its own, and
[`game.ts`](./packages/client/src/game.ts) is the loop, the socket and the renderer around
it. The HUD follows it: [`debug.ts`](./packages/client/src/debug.ts) and
[`audio.ts`](./packages/client/src/audio.ts) hold the arithmetic that can be wrong quietly
— a frame-rate window, a round trip, a footstep cadence, a fire-rate gate — and what those
numbers look and sound like is verified by playing.

A tick hands back the frames it produced as well as the state it left, which is how the
killfeed learns who killed whom: `simulate` returns `{ state, events }` and `net.ts` routes
them, the hit marker to the shooter alone, the kill to everybody, and a shot to everybody
but the person who fired it.

## Development

```bash
npm test         # vitest, all workspaces
npm run test:watch
npm run typecheck
npm run lint     # biome check
npm run format   # biome check --write
```

Tests live next to the code as `*.test.ts`. Logic is written test-first — see the TDD
note in PLAN.md. Most of them are pure and need no I/O; the exceptions are
`packages/server/src/net.test.ts`, which runs a real in-process WebSocket server, and the
client's `main.test.ts` and `controls.test.ts`, which drive the DOM under happy-dom against
the real `index.html` and real keyboard events.

The renderer is verified by playing it rather than by tests, with one exception: ramp
geometry is built from the same surface function collision reads, and `scene.test.ts`
checks they still agree — a slope you can see but not stand on is the bug that would
otherwise ship.

## Configuration

Copy `.env.example` to `.env` to override. Defaults live in
[`packages/server/src/config.ts`](./packages/server/src/config.ts), which is the only file
in the repo that reads `process.env`; everything else receives config as arguments.
Invalid values fail at boot with a message naming each offending variable.

| Var | Default | Meaning |
|---|---|---|
| `SERVER_PORT` | `8080` | HTTP/WS listen port |
| `TICK_RATE_HZ` | `20` | Server simulation rate |
| `MIN_PLAYERS` | `2` | Host cannot start below this (ignored when `GAME_MODE=dev`) |
| `MAX_PLAYERS` | `8` | Lobby capacity |
| `KILL_LIMIT` | `30` | Score that ends the match |
| `TIME_LIMIT_MINUTES` | `10` | Clock that ends the match |
| `RESPAWN_SECONDS` | `5` | Death to respawn delay |
| `SPAWN_PROTECTION_SECONDS` | `5` | Post-respawn invulnerability |
| `INTERMISSION_SECONDS` | `10` | Scoreboard time between one match and the next |
| `GAME_MODE` | `player` | `dev` adds the debug overlay, verbose logs and solo start |

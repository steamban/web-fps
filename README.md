# web-fps

Browser FPS, arcade style — server-authoritative, LAN/Tailscale-hostable, free-for-all deathmatch.

Full design and milestone breakdown: [PLAN.md](./PLAN.md).

## Status

**M4 — Combat.** Start a match and you can shoot each other. Every player carries the
same three weapons; the server raycasts each shot from where that tick left the shooter,
against the other players' hitboxes and through the map's geometry, and takes the health
off. A player at zero health stops moving and stops being drawn.

Not built yet: respawn, spawn protection, the win condition and the scoreboard (M5), so a
match effectively ends at the first kill; and no HUD — health, ammo, crosshair, killfeed
or hit marker (M6). Ammo and reloading do not exist yet either: the weapons' fire rates
bound how fast you can shoot, and nothing runs dry.

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

The server binds `0.0.0.0` and the port is published, so a second machine reaches it at
`http://<your-lan-ip>:8080` or `http://<your-tailscale-ip>:8080`. `packages/*/src` is
bind-mounted, so edits reload the server in place.

Only source is mounted; dependencies are baked into the image. That is why the command
above says `--build` — a plain `docker compose up` reuses whatever image exists, and one
built before a dependency was added fails at startup with
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '<name>'`. Rebuilding is a cache hit
when nothing has changed, so there is no reason not to always pass it.

Without Docker:

```bash
npm install
npm run dev          # server on :8080
npm run dev:client   # client on :5173
```

Open `http://localhost:5173`, type the server's `host:port` (the port alone defaults to
`8080`) and a name. The first person to join hosts and gets the lobby controls; everyone
else sees the player list. Open a second browser tab to play both sides — or set
`GAME_MODE=dev` to start a match on your own.

Once the host presses Start you are in the map: click to capture the mouse, WASD and
Space to move, click to fire, 1, 2 and 3 to switch between the SMG, the pistol and the
knife, Esc to release the mouse. The host keeps Pause and Close in the top-right corner.

**Movement sandbox** — the button under Join. It needs no server at all: it drops you into
the map alone so the movement can be tuned without a network round trip in the way. Click
to capture the mouse, WASD to move, Space to jump, Esc to release it.

The lobby lives entirely in [`packages/server/src/lobby.ts`](./packages/server/src/lobby.ts)
as pure `(state, args) -> { state, effects }` transitions, and the match in
[`simulation.ts`](./packages/server/src/simulation.ts) as `simulate(state, inputs, dt)`
with no clock and no sockets in it. [`net.ts`](./packages/server/src/net.ts) is the shell
that owns both of those things and carries the effects out. That split is what lets every
transition and every tick be proved by calling a function.

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
it.

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
| `GAME_MODE` | `player` | `dev` adds a debug HUD, verbose logs and solo start |

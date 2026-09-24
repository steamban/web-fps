# web-fps

Browser FPS, arcade style — server-authoritative, LAN/Tailscale-hostable, free-for-all deathmatch.

Full design and milestone breakdown: [PLAN.md](./PLAN.md).

## Status

**M2 — Single-player movement sandbox.** There is a map, and you can walk around it. WASD,
jump, mouse look, and hand-rolled AABB collision against boxes, ramps and the play-area
bounds, all running locally at 60 Hz against the same movement code the server will run.

Not built yet: the authoritative simulation (M3), so joining a lobby and starting a match
still only moves its phase — the sandbox is the only thing you can play.

## Layout

```
packages/
  shared/   wire protocol, weapon stats, map data and the sandbox map, collision + movement
  server/   Node server: config boundary, HTTP/WS host, lobby state machine (sim lands in M3)
  client/   Vite browser client: join screen, lobby, Three.js renderer and the movement loop
```

`shared` depends on nothing in this repo; `server` and `client` each depend only on
`shared` and never on each other. The only thing crossing that boundary is the wire protocol.

## Running it

With Docker — the way it is meant to be hosted:

```bash
docker compose up
curl http://localhost:8080/health
```

The server binds `0.0.0.0` and the port is published, so a second machine reaches it at
`http://<your-lan-ip>:8080` or `http://<your-tailscale-ip>:8080`. `packages/*/src` is
bind-mounted, so edits reload the server in place. Only source is mounted — after changing
a dependency, run `docker compose up --build`.

Without Docker:

```bash
npm install
npm run dev          # server on :8080
npm run dev:client   # client on :5173
```

Open `http://localhost:5173`, type the server's `host:port` (the port alone defaults to
`8080`) and a name. The first person to join hosts and gets the lobby controls; everyone
else sees the player list. Open a second browser tab to play both sides.

**Movement sandbox** — the button under Join. It needs no server at all: it drops you into
the map alone so the movement can be tuned without a network round trip in the way. Click
to capture the mouse, WASD to move, Space to jump, Esc to release it.

The lobby lives entirely in [`packages/server/src/lobby.ts`](./packages/server/src/lobby.ts)
as pure `(state, args) -> { state, effects }` transitions;
[`net.ts`](./packages/server/src/net.ts) is the socket shell that carries the effects out.
The same split will hold for the simulation in M3, which is what keeps both testable
without sockets.

Movement is the same idea. [`collision.ts`](./packages/shared/src/collision.ts) moves a box
through map geometry and knows nothing else;
[`movement.ts`](./packages/shared/src/movement.ts) owns the speeds, the jump and the player's
size and calls it. Both are pure and live in `shared`, so the client predicting a step and
the server deciding it in M3 run the identical code.

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

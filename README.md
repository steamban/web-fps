# web-fps

Browser FPS, arcade style — server-authoritative, LAN/Tailscale-hostable, free-for-all deathmatch.

Full design and milestone breakdown: [PLAN.md](./PLAN.md).

## Status

**M0 — Scaffold.** Monorepo, shared wire protocol, validated server config, Docker dev loop.
The lobby (M1), movement (M2) and netcode (M3+) are not built yet — the server currently
serves `/health` and nothing else.

## Layout

```
packages/
  shared/   types + Zod schemas for the wire protocol, weapon stats, map data shape
  server/   Node server: config boundary, HTTP/WS host (lobby and sim land in M1/M3)
  client/   Vite browser client (Three.js renderer lands in M2)
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

## Development

```bash
npm test         # vitest, all workspaces
npm run test:watch
npm run typecheck
npm run lint     # biome check
npm run format   # biome check --write
```

Tests live next to the code as `*.test.ts`. Logic is written test-first — see the TDD
note in PLAN.md.

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

# web-fps

Browser FPS, arcade style, LAN/Tailscale-hostable. [PLAN.md](./PLAN.md) is the design and the
milestone breakdown (M0–M7); [README.md](./README.md) covers running and configuring it.

## Read before starting work

Two sections of PLAN.md govern *how* to work here, not what to build:

- **Working agreement** — commit atomically as you go, with Conventional Commit messages.
  A milestone is many commits, never one. Every commit must pass `npm test`,
  `npm run lint` and `npm run typecheck` on its own, and tests ship in the same commit as
  the code they cover.
- **Design log** — read the entries for earlier milestones before starting one, and append
  your own decisions there in the same commit that makes them. Each milestone may be picked
  up in a different session, so a reason that is not written down is lost.

## Commands

```bash
npm test          # vitest, all workspaces
npm run typecheck # tsc --noEmit per package
npm run lint      # biome check
npm run format    # biome check --write
npm run dev       # server on :8080
npm run dev:client
```

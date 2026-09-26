import { z } from "zod";

/**
 * The single boundary between the process environment and the rest of the server.
 *
 * Nothing else in this package reads `process.env` — every other module takes the
 * values it needs as arguments. Invalid configuration fails at boot with a message
 * naming every offending variable, rather than surfacing mid-match.
 */

export const GAME_MODES = ["dev", "player"] as const;
export type GameMode = (typeof GAME_MODES)[number];

export interface Config {
  readonly serverPort: number;
  readonly tickRateHz: number;
  /** Fixed timestep the simulation advances by, derived from `tickRateHz`. */
  readonly tickIntervalMs: number;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly killLimit: number;
  readonly timeLimitMs: number;
  readonly respawnMs: number;
  readonly spawnProtectionMs: number;
  /** How long the scoreboard stays up between a match ending and the next one starting. */
  readonly intermissionMs: number;
  readonly gameMode: GameMode;
  /** Debug HUD, verbose logging, and solo start. See PLAN.md "Configuration". */
  readonly isDevMode: boolean;
}

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Docker and shell exports both surface "unset" as an empty string; treat it as absent.
 * Surrounding whitespace is stripped so ` dev ` and `20 ` behave the same as the enum and
 * the numeric coercion would on their own.
 */
const blankAsAbsent = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const envNumber = (schema: z.ZodType<number>, fallback: number) =>
  z.preprocess(blankAsAbsent, schema.default(fallback));

const integer = z.coerce.number().int();
const decimal = z.coerce.number();

const EnvSchema = z
  .object({
    SERVER_PORT: envNumber(integer.min(1).max(65535), 8080),
    TICK_RATE_HZ: envNumber(integer.min(1).max(240), 20),
    MIN_PLAYERS: envNumber(integer.min(1), 2),
    MAX_PLAYERS: envNumber(integer.min(1), 8),
    KILL_LIMIT: envNumber(integer.min(1), 30),
    TIME_LIMIT_MINUTES: envNumber(decimal.positive(), 10),
    RESPAWN_SECONDS: envNumber(decimal.nonnegative(), 5),
    SPAWN_PROTECTION_SECONDS: envNumber(decimal.nonnegative(), 5),
    INTERMISSION_SECONDS: envNumber(decimal.nonnegative(), 10),
    GAME_MODE: z.preprocess(blankAsAbsent, z.enum(GAME_MODES).default("player")),
  })
  .refine((env) => env.MIN_PLAYERS <= env.MAX_PLAYERS, {
    message: "MIN_PLAYERS must not exceed MAX_PLAYERS",
    path: ["MIN_PLAYERS"],
  });

function formatIssues(error: z.ZodError, env: Env): string {
  const lines = error.issues.map((issue) => {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : "config";
    const received = env[variable];
    // Coercion turns "abc" into NaN, so echo what was actually set to make the typo obvious.
    const actual = received === undefined ? "" : ` (received ${JSON.stringify(received)})`;
    return `  ${variable}: ${issue.message}${actual}`;
  });
  return `Invalid server configuration:\n${lines.join("\n")}`;
}

/**
 * Parses and validates the environment. Throws with every problem listed at once,
 * so a misconfigured deployment does not need one restart per typo.
 */
export function loadConfig(env: Env = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(formatIssues(result.error, env));
  }

  const parsed = result.data;
  return {
    serverPort: parsed.SERVER_PORT,
    tickRateHz: parsed.TICK_RATE_HZ,
    tickIntervalMs: 1000 / parsed.TICK_RATE_HZ,
    minPlayers: parsed.MIN_PLAYERS,
    maxPlayers: parsed.MAX_PLAYERS,
    killLimit: parsed.KILL_LIMIT,
    timeLimitMs: Math.round(parsed.TIME_LIMIT_MINUTES * 60_000),
    respawnMs: Math.round(parsed.RESPAWN_SECONDS * 1000),
    spawnProtectionMs: Math.round(parsed.SPAWN_PROTECTION_SECONDS * 1000),
    intermissionMs: Math.round(parsed.INTERMISSION_SECONDS * 1000),
    gameMode: parsed.GAME_MODE,
    isDevMode: parsed.GAME_MODE === "dev",
  };
}

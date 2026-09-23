import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig defaults", () => {
  it("applies every documented default when the environment is empty", () => {
    expect(loadConfig({})).toEqual({
      serverPort: 8080,
      tickRateHz: 20,
      tickIntervalMs: 50,
      minPlayers: 2,
      maxPlayers: 8,
      killLimit: 30,
      timeLimitMs: 600_000,
      respawnMs: 5000,
      spawnProtectionMs: 5000,
      gameMode: "player",
      isDevMode: false,
    });
  });

  it("treats an empty string as unset rather than as zero", () => {
    expect(loadConfig({ SERVER_PORT: "", GAME_MODE: "  " })).toMatchObject({
      serverPort: 8080,
      gameMode: "player",
    });
  });

  it("tolerates whitespace around a value", () => {
    expect(loadConfig({ TICK_RATE_HZ: " 30 ", GAME_MODE: " dev " })).toMatchObject({
      tickRateHz: 30,
      gameMode: "dev",
    });
  });
});

describe("loadConfig parsing", () => {
  it("reads overrides from the environment", () => {
    const config = loadConfig({
      SERVER_PORT: "9000",
      TICK_RATE_HZ: "60",
      MIN_PLAYERS: "1",
      MAX_PLAYERS: "4",
      KILL_LIMIT: "15",
      TIME_LIMIT_MINUTES: "5",
      RESPAWN_SECONDS: "3",
      SPAWN_PROTECTION_SECONDS: "2",
      GAME_MODE: "dev",
    });

    expect(config).toEqual({
      serverPort: 9000,
      tickRateHz: 60,
      tickIntervalMs: 1000 / 60,
      minPlayers: 1,
      maxPlayers: 4,
      killLimit: 15,
      timeLimitMs: 300_000,
      respawnMs: 3000,
      spawnProtectionMs: 2000,
      gameMode: "dev",
      isDevMode: true,
    });
  });

  it("converts human units to the milliseconds the simulation works in", () => {
    const config = loadConfig({ TIME_LIMIT_MINUTES: "0.5", RESPAWN_SECONDS: "1.5" });
    expect(config.timeLimitMs).toBe(30_000);
    expect(config.respawnMs).toBe(1500);
  });

  it("ignores environment variables it does not own", () => {
    expect(loadConfig({ PATH: "/usr/bin", HOME: "/root" }).serverPort).toBe(8080);
  });
});

describe("loadConfig validation", () => {
  it("rejects a non-numeric value", () => {
    expect(() => loadConfig({ SERVER_PORT: "eighty-eighty" })).toThrow(/SERVER_PORT/);
  });

  it("rejects a port outside the valid range", () => {
    expect(() => loadConfig({ SERVER_PORT: "0" })).toThrow(/SERVER_PORT/);
    expect(() => loadConfig({ SERVER_PORT: "70000" })).toThrow(/SERVER_PORT/);
  });

  it("rejects a fractional tick rate", () => {
    expect(() => loadConfig({ TICK_RATE_HZ: "20.5" })).toThrow(/TICK_RATE_HZ/);
  });

  it("rejects a tick rate that would peg the CPU", () => {
    expect(() => loadConfig({ TICK_RATE_HZ: "2000" })).toThrow(/TICK_RATE_HZ/);
  });

  it("rejects negative durations", () => {
    expect(() => loadConfig({ RESPAWN_SECONDS: "-1" })).toThrow(/RESPAWN_SECONDS/);
    expect(() => loadConfig({ TIME_LIMIT_MINUTES: "0" })).toThrow(/TIME_LIMIT_MINUTES/);
  });

  it("rejects a minimum player count above the maximum", () => {
    expect(() => loadConfig({ MIN_PLAYERS: "6", MAX_PLAYERS: "4" })).toThrow(
      /MIN_PLAYERS must not exceed MAX_PLAYERS/,
    );
  });

  it("allows minimum equal to maximum", () => {
    expect(loadConfig({ MIN_PLAYERS: "4", MAX_PLAYERS: "4" }).minPlayers).toBe(4);
  });

  it("rejects an unknown game mode", () => {
    expect(() => loadConfig({ GAME_MODE: "sandbox" })).toThrow(/GAME_MODE/);
  });

  it("reports every invalid variable in one message", () => {
    expect(() => loadConfig({ SERVER_PORT: "-1", KILL_LIMIT: "0" })).toThrow(
      /SERVER_PORT[\s\S]*KILL_LIMIT/,
    );
  });
});

describe("loadConfig error messages", () => {
  it("echoes the offending value so a typo is obvious", () => {
    expect(() => loadConfig({ SERVER_PORT: "eighty-eighty" })).toThrow(/received "eighty-eighty"/);
  });
});

describe("loadConfig source", () => {
  it("reads process.env when called with no argument", () => {
    const previous = process.env.SERVER_PORT;
    process.env.SERVER_PORT = "7777";
    try {
      expect(loadConfig().serverPort).toBe(7777);
    } finally {
      if (previous === undefined) delete process.env.SERVER_PORT;
      else process.env.SERVER_PORT = previous;
    }
  });
});

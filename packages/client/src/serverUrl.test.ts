import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, toWebSocketUrl } from "./serverUrl";

describe("toWebSocketUrl", () => {
  it("accepts the host:port a player reads off the host's screen", () => {
    expect(toWebSocketUrl("192.168.1.5:8080")).toBe("ws://192.168.1.5:8080/ws");
  });

  it("assumes the server's default port when none is typed", () => {
    expect(toWebSocketUrl("192.168.1.5")).toBe(`ws://192.168.1.5:${DEFAULT_PORT}/ws`);
  });

  it("ignores surrounding whitespace from a paste", () => {
    expect(toWebSocketUrl("  192.168.1.5:9000  ")).toBe("ws://192.168.1.5:9000/ws");
  });

  it("accepts a hostname", () => {
    expect(toWebSocketUrl("desktop.tail1234.ts.net:8080")).toBe(
      "ws://desktop.tail1234.ts.net:8080/ws",
    );
  });

  it("accepts a bracketed IPv6 address, as Tailscale hands out", () => {
    expect(toWebSocketUrl("[fd7a:115c:a1e0::1]:8080")).toBe("ws://[fd7a:115c:a1e0::1]:8080/ws");
  });

  it("rewrites a pasted http:// address", () => {
    expect(toWebSocketUrl("http://192.168.1.5:8080")).toBe("ws://192.168.1.5:8080/ws");
  });

  it("is idempotent on an address it produced", () => {
    const url = toWebSocketUrl("192.168.1.5:8080");
    expect(toWebSocketUrl(url)).toBe(url);
  });

  it("drops a path, query or fragment rather than sending it to the server", () => {
    expect(toWebSocketUrl("192.168.1.5:8080/lobby?x=1#y")).toBe("ws://192.168.1.5:8080/ws");
  });

  it("uses wss when the page itself was served over https", () => {
    expect(toWebSocketUrl("192.168.1.5:8080", true)).toBe("wss://192.168.1.5:8080/ws");
  });

  it("rejects an empty address with a message a player can act on", () => {
    expect(() => toWebSocketUrl("   ")).toThrow(/192\.168/);
  });

  it("rejects an unparseable address", () => {
    expect(() => toWebSocketUrl("not a host")).toThrow(/not a host/);
    expect(() => toWebSocketUrl("192.168.1.5:notaport")).toThrow();
  });
});

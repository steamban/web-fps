import { WS_PATH } from "@web-fps/shared";

/**
 * Turns whatever a player types into the WebSocket URL for that host — the address is
 * read off someone else's screen at a LAN party, so `192.168.1.5`, `192.168.1.5:8080`
 * and a pasted `http://...` all have to work.
 */

/** Mirrors the server's `SERVER_PORT` default; type the port if the host changed it. */
export const DEFAULT_PORT = 8080;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function toWebSocketUrl(input: string, secure = false): string {
  const address = input.trim();
  if (address === "") throw new Error("Enter the host's address, e.g. 192.168.1.5:8080");

  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(address) ? address : `ws://${address}`);
  } catch {
    throw new Error(`"${address}" is not a host address`);
  }

  url.protocol = secure ? "wss:" : "ws:";
  if (url.port === "") url.port = String(DEFAULT_PORT);
  // The endpoint is fixed; anything the player pasted after the host is noise.
  url.pathname = WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

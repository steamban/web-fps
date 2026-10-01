import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

/**
 * Serves the built client next to the WebSocket it connects to, so hosting the game is
 * one container and one published port: a player opens `http://<host>:8080`, gets the
 * page, and the page dials back to the origin it came from.
 *
 * A URL is attacker-controlled, so the path it names is resolved and then checked to be
 * inside the root — `..` and its encodings are the one thing between this and the host's
 * filesystem.
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * The file a request URL names, or null if it names nothing servable: outside the root,
 * undecodable, or a type this does not serve. `/` is the page itself.
 *
 * Kept free of the filesystem so the traversal rule is testable as arithmetic on strings.
 */
export function resolveAssetPath(root: string, requestUrl: string): string | null {
  let pathname: string;
  try {
    // The base is a throwaway: it only makes a relative URL parseable, and gives
    // percent-decoding (so `%2e%2e` is `..` by the time the root check sees it).
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return null;
  }

  const candidate = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  const inside = relative(root, candidate);
  if (inside === "" || inside.startsWith("..") || inside.startsWith(sep)) return null;

  return extname(candidate) in CONTENT_TYPES ? candidate : null;
}

/** Sends the file a GET names under `root`. False means nothing was sent — fall through. */
export async function serveAsset(
  root: string,
  method: string | undefined,
  requestUrl: string,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") return false;

  const file = resolveAssetPath(root, requestUrl);
  if (file === null) return false;
  if (
    !(await stat(file).then(
      (s) => s.isFile(),
      () => false,
    ))
  )
    return false;

  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] as string });
  if (method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}

/** Where `npm run build --workspace @web-fps/client` puts the page, in dev and in the image alike. */
export const CLIENT_DIST = join(resolve(import.meta.dirname, "../.."), "client", "dist");

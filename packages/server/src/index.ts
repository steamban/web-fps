import { createServer } from "node:http";
import { WS_PATH } from "@web-fps/shared";
import { loadConfig } from "./config";
import { attachLobbyServer } from "./net";
import { CLIENT_DIST, serveAsset } from "./static";

/**
 * Server entrypoint: configuration boundary, health check, and the WebSocket lobby.
 * The authoritative simulation attaches to this same server in M3.
 *
 * Binds 0.0.0.0 deliberately so the container port publish makes it reachable over
 * LAN and Tailscale, not just from inside the container.
 *
 * It also serves the built client, when one has been built, so hosting a game is one
 * port to publish and one address to read out. Without a build the page 404s and the
 * Vite dev server is where the client lives instead.
 */

const HOST = "0.0.0.0";

function main(): void {
  const config = loadConfig();

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", gameMode: config.gameMode }));
      return;
    }
    void serveAsset(CLIENT_DIST, req.method, req.url ?? "/", res).then((served) => {
      if (served) return;
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });

  const lobby = attachLobbyServer(server, config);

  server.listen(config.serverPort, HOST, () => {
    console.log(
      `web-fps server listening on ${HOST}:${config.serverPort}${WS_PATH} [${config.gameMode}]`,
    );
    if (config.isDevMode) {
      console.log("config:", config);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // Drop the sockets first: an open WebSocket would otherwise keep server.close() waiting.
    process.on(signal, () => {
      void lobby.close().then(() => server.close(() => process.exit(0)));
    });
  }
}

main();

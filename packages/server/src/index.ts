import { createServer } from "node:http";
import { loadConfig } from "./config";

/**
 * Server entrypoint. For now it only proves the configuration boundary and the
 * network binding work: the lobby and the authoritative simulation land in M1/M3,
 * attached to this same HTTP server.
 *
 * Binds 0.0.0.0 deliberately so the container port publish makes it reachable over
 * LAN and Tailscale, not just from inside the container.
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
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(config.serverPort, HOST, () => {
    console.log(`web-fps server listening on ${HOST}:${config.serverPort} [${config.gameMode}]`);
    if (config.isDevMode) {
      console.log("config:", config);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

main();

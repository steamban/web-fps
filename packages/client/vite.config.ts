import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Bind all interfaces so the dev client is reachable from a second machine
    // on the LAN or over Tailscale, matching how the server is published.
    host: true,
    port: 5173,
  },
});

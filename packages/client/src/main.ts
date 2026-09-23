import { LOADOUT, PROTOCOL_VERSION } from "@web-fps/shared";

// Placeholder entrypoint. The join screen lands in M1 and the Three.js renderer in M2;
// for now this only proves the shared protocol package resolves from the browser build.
const app = document.querySelector<HTMLDivElement>("#app");
if (app) {
  app.textContent = `web-fps client — protocol v${PROTOCOL_VERSION}, ${
    Object.keys(LOADOUT).length
  } weapon slots`;
}

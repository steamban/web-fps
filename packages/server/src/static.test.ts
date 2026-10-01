import { describe, expect, it } from "vitest";
import { resolveAssetPath } from "./static";

const ROOT = "/srv/dist";

describe("resolveAssetPath", () => {
  it("serves the page itself at the root", () => {
    expect(resolveAssetPath(ROOT, "/")).toBe("/srv/dist/index.html");
  });

  it("serves an asset and ignores the query the bundler appends", () => {
    expect(resolveAssetPath(ROOT, "/assets/main-a1b2.js?v=3")).toBe("/srv/dist/assets/main-a1b2.js");
  });

  it.each([
    // `new URL` collapses a plain `..` before this ever sees it; a percent-encoded one
    // survives parsing and is only caught by the root check, which is why it is the case
    // that matters.
    ["encoded traversal", "/%2e%2e/%2e%2e/etc/passwd"],
    ["an encoded absolute path", "/%2e%2e%2fetc%2fpasswd"],
    ["an undecodable path", "/%ZZ/index.html"],
  ])("refuses %s", (_name, url) => {
    expect(resolveAssetPath(ROOT, url)).toBeNull();
  });

  it("keeps a plain `..` inside the root rather than refusing it, because the URL parser normalises it away", () => {
    expect(resolveAssetPath(ROOT, "/../../etc/passwd")).toBeNull();
    expect(resolveAssetPath(ROOT, "/../assets/main.js")).toBe("/srv/dist/assets/main.js");
  });

  it("refuses a file type it has no content type for", () => {
    expect(resolveAssetPath(ROOT, "/.env")).toBeNull();
    expect(resolveAssetPath(ROOT, "/package.json.bak")).toBeNull();
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// The handler is plain CommonJS in the Electron main process, so it is loaded the same way there.
const require_ = createRequire(import.meta.url);
const { resolveFile, createHandler } = require_("../desktop/protocol.js");

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pos-protocol-"));
  const write = (rel: string, body = "x") => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  write("index.html");
  write("login/index.html");
  write("pos/index.html");
  write("pos/index.txt");
  write("404.html");
  // Next 16 stores flight payloads under a directory named after the route.
  write("pos/__next.pos/__PAGE__.txt");
  write("pos/__next._full.txt");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("export resolution", () => {
  it("serves a route directory", () => {
    expect(resolveFile(root, "/pos/")).toBe(path.join(root, "pos", "index.html"));
  });

  it("serves the root", () => {
    expect(resolveFile(root, "/")).toBe(path.join(root, "index.html"));
  });

  it("maps a prefetched flight payload to where the export stores it", () => {
    // Requested as `__next.pos.__PAGE__.txt`, written as `__next.pos/__PAGE__.txt`.
    expect(resolveFile(root, "/pos/__next.pos.__PAGE__.txt")).toBe(
      path.join(root, "pos", "__next.pos", "__PAGE__.txt"),
    );
  });

  it("keeps an exact .txt request working", () => {
    expect(resolveFile(root, "/pos/__next._full.txt")).toBe(
      path.join(root, "pos", "__next._full.txt"),
    );
  });

  it("returns null for an unknown route instead of falling back to a page", () => {
    expect(resolveFile(root, "/nope/")).toBeNull();
  });

  it("refuses to escape the bundle", () => {
    expect(resolveFile(root, "/../package.json")).toBeNull();
  });
});

describe("response handling", () => {
  it("answers a prefetch instead of 404ing", async () => {
    const handle = createHandler(root);
    const response = await handle(
      new Request("app://till/pos/__next.pos.__PAGE__.txt?_rsc=abc"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("marks HTML uncached but hashed assets immutable", async () => {
    const handle = createHandler(root);
    const html = await handle(new Request("app://till/login/"));
    expect(html.headers.get("cache-control")).toBe("no-cache");
    const payload = await handle(new Request("app://till/pos/__next.pos.__PAGE__.txt"));
    expect(payload.headers.get("cache-control")).toMatch(/immutable/);
  });

  it("uses the 404 page for unknown paths", async () => {
    const handle = createHandler(root);
    const response = await handle(new Request("app://till/missing/"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("x");
  });
});

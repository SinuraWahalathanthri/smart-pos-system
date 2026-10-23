"use strict";

/**
 * Turns the static export on disk into responses for the app:// scheme.
 *
 * Extracted from main.js so the smoke test serves the bundle exactly the same way the shipped app
 * does - a smoke test with its own copy of this logic would happily pass while the real app broke.
 */

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

/**
 * Map a URL path to a file in the export, refusing anything that escapes the bundle.
 *
 * A static export writes `pos/index.html` for /pos. Unknown paths must NOT all fall back to
 * index.html: that would turn a typo into a copy of the dashboard and hide real 404s.
 */
function resolveFile(root, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  rel = rel.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";

  // Route payloads are written as `route/index.txt` and requested without the extension.
  const candidates = [rel];
  if (!path.extname(rel)) candidates.push(`${rel}.html`, `${rel}/index.html`);

  // Next 16 requests RSC payloads as `__next.<route>.<segment>.txt` but stores them one level
  // deeper: `__next.<route>/<segment>.txt`. Without this, every prefetch for a nested route
  // segment 404s and client-side navigation silently degrades to a full page load.
  if (rel.endsWith(".txt")) {
    const stem = rel.slice(0, -".txt".length);
    const cut = stem.lastIndexOf(".");
    if (cut > 0) candidates.push(`${stem.slice(0, cut)}/${stem.slice(cut + 1)}.txt`);
  }

  const base = path.resolve(root);
  for (const candidate of candidates) {
    const full = path.resolve(base, candidate);
    // Containment check: a crafted `..%2f..%2f` must not read outside the bundle.
    if (full !== base && !full.startsWith(base + path.sep)) continue;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

/**
 * The one origin the bundle is served from.
 *
 * A registered "standard" scheme parses the first segment as a HOST, so `app://pos/` would mean
 * host "pos" and path "/" - every route would collapse onto the root page. The host is therefore
 * fixed and the whole route lives in the path: `app://till/pos/`. A constant host also means one
 * stable origin, so localStorage and IndexedDB survive upgrades.
 */
const APP_HOST = "till";
const APP_ORIGIN = `app://${APP_HOST}`;
/** A Request-handler body for protocol.handle(). */
function createHandler(root) {
  return async function handle(request) {
    const { pathname } = new URL(request.url);
    const file = resolveFile(root, pathname);

    if (!file) {
      const notFound = path.join(root, "404.html");
      return new Response(fs.existsSync(notFound) ? await fsp.readFile(notFound) : "Not found", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const body = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": MIME[ext] || "application/octet-stream",
        // Assets are content-hashed per build so they can be cached hard; HTML cannot.
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  };
}

module.exports = { resolveFile, createHandler, MIME, APP_HOST, APP_ORIGIN };

import type { NextConfig } from "next";
/**
 * One codebase, two targets.
 *
 * Vercel keeps the normal server build. The desktop build sets BUILD_TARGET=desktop and becomes a
 * static export that ships inside the Electron app, because an installed till cannot rely on a
 * Node server being present on the shop counter. Nothing here changes the web deployment.
 */
const isDesktop = process.env.BUILD_TARGET === "desktop";
const nextConfig: NextConfig = {
  ...(isDesktop
    ? {
        output: "export" as const,
        // Electron serves the export from disk, where every route has to be a real file.
        trailingSlash: true,
        // A static export has no optimisation server.
        images: { unoptimized: true },
      }
    : {
        cacheComponents: true,
        partialPrefetching: true,
      }),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};
export default nextConfig;

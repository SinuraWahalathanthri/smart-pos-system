import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Every database test boots its own PGlite (Postgres in WebAssembly) instance. Running the file
    // for every CPU core saturates memory and makes schema.test.ts flake on its default 10s hook
    // timeout, so cap the pool and give the setup hooks room for the full migration chain.
    maxWorkers: 4,
    hookTimeout: 30_000,
  },
});

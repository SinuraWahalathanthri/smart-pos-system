#!/usr/bin/env node
/**
 * One command to try the till in connected mode with no Supabase account:
 *   npm run dev:mock
 * Starts the local mock backend and the app together, with the app pointed at the mock.
 * (It sets the variables for this run only; your .env.local is untouched.)
 */
import { spawn } from "node:child_process";

const PORT = process.env.MOCK_PORT ?? "54321";
const env = {
  ...process.env,
  PORT,
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PORT}`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock-anon-key",
};

const run = (cmd, args) => spawn(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
const mock = run("node", ["scripts/mock-supabase.mjs"]);
const app = run("npx", ["next", "dev", "--port", process.env.APP_PORT ?? "3100"]);

const stop = () => {
  mock.kill();
  app.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
mock.on("exit", () => app.kill());
app.on("exit", () => mock.kill());

/**
 * Materialises `supabase.config.json` at the project root so electron-builder can ship it as a
 * resource, making an installer that arrives already connected.
 *
 *   POS_SUPABASE_URL=https://xxx.supabase.co POS_SUPABASE_ANON_KEY=eyJ... npm run dist:win
 *
 * Why a file and not NEXT_PUBLIC_*: the Next bundler inlines those into the website build, which
 * would bake one shop's project into the public web deployment. A separate resource keeps the same
 * source tree producing both a generic web build and a preconfigured desktop build, and an
 * administrator can swap the file on an installed machine without rebuilding.
 *
 * With neither variable set the file is removed, so a generic installer cannot inherit the project
 * from an earlier preconfigured build in the same checkout.
 *
 * The anon key is public by design - every browser bundle ships one - and row level security is what
 * protects the data. A service-role key is refused here because it bypasses RLS entirely.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const TARGET = path.join(ROOT, "supabase.config.json");

const KEYS = ["POS_SUPABASE_URL", "POS_SUPABASE_ANON_KEY"];

/**
 * Reads the two build keys from `.env.local` then `.env`, the same order Next uses, so the values can
 * live next to the other project settings instead of only in the shell. A real environment variable
 * still wins, because a CI job sets those and must not be overridden by a stray file.
 *
 * Parsed by hand rather than with `process.loadEnvFile` because PowerShell 5.1's
 * `Set-Content -Encoding UTF8` writes a BOM, which makes the first key name `\uFEFFPOS_SUPABASE_URL`
 * and silently drops it - exactly the failure that looks like "I set it but nothing happened".
 */
function readEnvFiles() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, raw] = match;
      if (!KEYS.includes(key) || process.env[key]) continue;
      process.env[key] = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

readEnvFiles();

const url = String(process.env.POS_SUPABASE_URL || "").trim().replace(/\/$/, "");
const anonKey = String(process.env.POS_SUPABASE_ANON_KEY || "").trim();

if (!url && !anonKey) {
  fs.rmSync(TARGET, { force: true });
  console.log("desktop config: none supplied, packaging a generic installer");
} else if (!url || !anonKey) {
  throw new Error("Set both POS_SUPABASE_URL and POS_SUPABASE_ANON_KEY, or neither.");
} else {
  if (anonKey.startsWith("sb_secret_")) {
    throw new Error("POS_SUPABASE_ANON_KEY looks like a secret key. Use the anon/publishable key.");
  }
  if (!/^https:\/\/[^/]+\.supabase\.(co|in)$/.test(url)) {
    throw new Error(`POS_SUPABASE_URL must be https://<ref>.supabase.co, got ${url}`);
  }
  fs.writeFileSync(TARGET, JSON.stringify({ url, anonKey }, null, 2) + "\n");
  console.log(`desktop config: preconfigured for ${url}`);
}

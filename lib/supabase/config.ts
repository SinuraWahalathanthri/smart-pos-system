/**
 * Runtime Supabase configuration, stored on the device instead of baked in at build time.
 *
 * Why not `.env`: `NEXT_PUBLIC_*` variables are inlined by the bundler, so a shopkeeper who wants to
 * point the installed app at their own Supabase project would have to rebuild it. This app is meant
 * to be handed over as a desktop installer and configured by pasting a URL and an anon key, so the
 * credentials are read at runtime and kept in the device's local storage.
 *
 * What is stored is the anon/publishable key, which is designed to be public: it ships inside every
 * browser bundle. It is NOT a service-role key, and it grants nothing on its own - row level security
 * in Supabase decides what the signed-in user may read or write. We still refuse anything that looks
 * like a service-role key, because pasting one would hand the whole database to every till.
 *
 * A build may still supply defaults via NEXT_PUBLIC_* for a single-shop deployment. Those act as a
 * fallback only, so the same binary can be reconfigured in the field without a rebuild.
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

const STORAGE_KEY = "pos.supabase.config";

/** Build-time fallbacks. Empty in a distributable build; set for a fixed single-shop deployment. */
const BUILD_DEFAULTS: SupabaseConfig = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};

let cached: SupabaseConfig | null | undefined;

export type ConfigProblem = { field: "url" | "anonKey"; message: string };

/**
 * Validates before saving so a typo is caught in the setup screen rather than at the first sale.
 * A project URL is always https://<ref>.supabase.co with no path and no trailing slash.
 */
export function validateConfig(raw: Partial<SupabaseConfig>): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const url = (raw.url ?? "").trim();
  const key = (raw.anonKey ?? "").trim();

  if (!url) {
    problems.push({ field: "url", message: "Project URL is required." });
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      problems.push({ field: "url", message: "That is not a valid URL." });
    }
    if (parsed) {
      if (parsed.protocol !== "https:") {
        problems.push({ field: "url", message: "Use https:// - Supabase requires TLS." });
      }
      if (!/\.supabase\.(co|in)$/.test(parsed.hostname)) {
        problems.push({
          field: "url",
          message: "Expected a Supabase project URL, for example https://abcd1234.supabase.co",
        });
      }
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
        problems.push({ field: "url", message: "Use only the project root, with no path or trailing slash." });
      }
    }
  }

  if (!key) {
    problems.push({ field: "anonKey", message: "Anon (publishable) key is required." });
  } else {
    // Supabase anon keys are JWTs or the newer sb_publishable_ format.
    if (/^sb_secret_/.test(key) || looksLikeServiceRole(key)) {
      problems.push({
        field: "anonKey",
        message: "This is a secret/service-role key, which bypasses row level security. Use the anon key.",
      });
    } else if (!/^sb_publishable_/.test(key) && !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) {
      problems.push({ field: "anonKey", message: "That does not look like a Supabase anon key." });
    }
  }

  return problems;
}

/**
 * The role claim sits in the JWT payload. Decoding it locally is not a security check - Supabase
 * still enforces the role - it only prevents a shopkeeper pasting a key that would silently make
 * every till all-powerful.
 */
function looksLikeServiceRole(jwt: string): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { role?: string };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

function readStored(): SupabaseConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SupabaseConfig>;
    if (!parsed.url || !parsed.anonKey) return null;
    return { url: parsed.url, anonKey: parsed.anonKey };
  } catch {
    // Corrupt entry: fall back to build defaults rather than crashing the till at boot.
    return null;
  }
}

/**
 * The active config: what the shopkeeper saved, else the build default, else nothing.
 * Returns null when the app should run in demo mode on local data.
 */
export function getSupabaseConfig(): SupabaseConfig | null {
  if (cached !== undefined) return cached;
  const stored = readStored();
  if (stored) {
    cached = stored;
    return cached;
  }
  const fallback = BUILD_DEFAULTS.url && BUILD_DEFAULTS.anonKey ? BUILD_DEFAULTS : null;
  cached = fallback;
  return cached;
}

/** True when a config exists, so screens can show demo mode instead of failing. */
export function hasSupabaseConfig(): boolean {
  return getSupabaseConfig() !== null;
}

export function saveSupabaseConfig(config: SupabaseConfig): void {
  if (typeof window === "undefined") return;
  const clean = { url: config.url.trim().replace(/\/$/, ""), anonKey: config.anonKey.trim() };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  cached = clean;
}

export function clearSupabaseConfig(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  cached = BUILD_DEFAULTS.url && BUILD_DEFAULTS.anonKey ? BUILD_DEFAULTS : null;
}

/** Test hook: drop the memoised value so a changed store is re-read. */
export function resetConfigCache(): void {
  cached = undefined;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  /** Which migration has been applied, so setup can say "schema is behind". */
  schemaVersion?: string;
}

/**
 * Proves the credentials work before they are saved.
 *
 * Auth's /settings endpoint is the only honest way to test the key. PostgREST cannot be used for
 * this: 0002 revokes every grant from anon, so an unauthenticated REST call fails with 42501
 * (insufficient_privilege) even when the key is perfect. Testing REST therefore reported a good key
 * as "rejected" and sent shopkeepers to re-copy a key that was never wrong.
 */
export async function testConnection(config: SupabaseConfig): Promise<ConnectionResult> {
  const problems = validateConfig(config);
  if (problems.length) return { ok: false, message: problems[0].message };

  const base = config.url.trim().replace(/\/$/, "");
  const headers = { apikey: config.anonKey };

  let res: Response;
  try {
    res = await fetch(`${base}/auth/v1/settings`, { headers, method: "GET" });
  } catch {
    return { ok: false, message: "Could not reach that URL. Check the address and the connection." };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: "The key was rejected. Copy the anon key again from Supabase." };
  }
  if (!res.ok) {
    return { ok: false, message: `Supabase replied ${res.status}. Check the project URL.` };
  }

  // Can the schema be checked before sign-in? Not really, and claiming otherwise was the second
  // half of this bug. 0002 revokes every grant from anon, so an anonymous request to any table is
  // refused with 42501 whether or not the migration ran. A refusal here says nothing about the
  // schema, so it must not be reported as either success or failure. A 404 does mean the table is
  // genuinely absent from PostgREST's schema cache.
  try {
    const probe = await fetch(`${base}/rest/v1/stores?select=id&limit=1`, { headers });
    if (probe.status === 404) {
      return {
        ok: false,
        message: "Connected, but the POS schema is missing. Run the migrations in supabase/migrations first.",
      };
    }
  } catch {
    return { ok: false, message: "Connected to the project, but the schema check was blocked." };
  }

  // Verified for real on the first signed-in request (my_shop / my_stores), which cannot be spoofed
  // by an unauthenticated probe.
  return { ok: true, message: "Connected. The schema is checked when you sign in." };
}

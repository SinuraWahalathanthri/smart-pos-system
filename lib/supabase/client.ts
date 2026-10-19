import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./config";

/**
 * The till talks to Supabase only when the device has been configured (see lib/supabase/config.ts).
 * Credentials are read at runtime, so the installed app can be pointed at a project without a rebuild.
 * Without them it runs in demo mode on local data, exactly as before.
 */
export function isConnected(): boolean {
  return getSupabaseConfig() !== null;
}

let client: SupabaseClient | null = null;
let clientKey = "";

export function getSupabase(): SupabaseClient {
  const config = getSupabaseConfig();
  if (!config) {
    throw new Error("Supabase is not configured. Open Settings and paste your project URL and anon key.");
  }
  // Rebuild when the shopkeeper changes credentials, otherwise the old client keeps the old key.
  const key = `${config.url}\u0000${config.anonKey}`;
  if (client && clientKey === key) return client;

  client = createClient(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  clientKey = key;
  return client;
}

/** Drop the cached client after the stored config changes. */
export function resetSupabaseClient(): void {
  client = null;
  clientKey = "";
}

/** Just enough of the client for the sync code, so tests can pass a stand-in. */
export interface SbError {
  message: string;
  code?: string;
  status?: number;
}

export interface SbClient {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: SbError | null }>;
  from: (table: string) => {
    select: (columns: string) => {
      range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: SbError | null }>;
    };
  };
}

export const asSbClient = (c: SupabaseClient): SbClient => c as unknown as SbClient;

/** The device has no connection (as opposed to the server refusing the request). */
export function isNetworkError(e: SbError | { message?: string } | null | undefined): boolean {
  if (!e) return false;
  const status = (e as SbError).status;
  if (status === 0) return true;
  return /failed to fetch|fetch failed|network|timed? ?out|econn|enotfound|load failed|offline/i.test(e.message ?? "");
}

/** The device sign-in is missing or expired, so the till must sign in again. */
export function isAuthError(e: SbError | null | undefined): boolean {
  if (!e) return false;
  return e.code === "28000" || e.status === 401 || e.status === 403 || /jwt|not_authenticated|not authenticated/i.test(e.message ?? "");
}

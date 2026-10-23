import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSupabaseConfig,
  getSupabaseConfig,
  hasSupabaseConfig,
  isSupabaseConfigShipped,
  resetConfigCache,
  saveSupabaseConfig,
  testConnection,
  validateConfig,
} from "../lib/supabase/config";

/**
 * These cover the failure mode that matters in a shop: a shopkeeper pastes credentials at setup time
 * and expects them to survive a restart. A silent misconfiguration here shows up later as failed
 * syncs on real sales, so validation is strict and the stored value is asserted, not assumed.
 */

// Minimal localStorage - the app is a desktop shell, so there is no jsdom here.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const storage = new MemoryStorage();

// A structurally valid anon JWT (payload only matters for the service-role check).
const jwt = (payload: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");

const ANON = jwt({ role: "anon" });
const SERVICE = jwt({ role: "service_role" });
const URL_OK = "https://abcdefghijklmnop.supabase.co";

beforeEach(() => {
  storage.clear();
  resetConfigCache();
  vi.stubGlobal("window", { localStorage: storage });
  vi.unstubAllGlobals();
  vi.stubGlobal("window", { localStorage: storage });
});

describe("credential validation", () => {
  it("accepts a real project URL and anon key", () => {
    expect(validateConfig({ url: URL_OK, anonKey: ANON })).toEqual([]);
  });

  it("accepts the newer publishable key format", () => {
    expect(validateConfig({ url: URL_OK, anonKey: "sb_publishable_abc123" })).toEqual([]);
  });

  it("rejects a service-role key", () => {
    const problems = validateConfig({ url: URL_OK, anonKey: SERVICE });
    expect(problems).toHaveLength(1);
    expect(problems[0].field).toBe("anonKey");
    expect(problems[0].message).toMatch(/service-role|secret/i);
  });

  it("rejects a secret key", () => {
    const problems = validateConfig({ url: URL_OK, anonKey: "sb_secret_xyz" });
    expect(problems[0].message).toMatch(/service-role|secret/i);
  });

  it("rejects plain http", () => {
    const problems = validateConfig({ url: "http://abcdefgh.supabase.co", anonKey: ANON });
    expect(problems.some((p) => /https/i.test(p.message))).toBe(true);
  });

  it("rejects a URL with a trailing path", () => {
    const problems = validateConfig({ url: `${URL_OK}/rest/v1`, anonKey: ANON });
    expect(problems.some((p) => /root|path/i.test(p.message))).toBe(true);
  });

  it("rejects a non-Supabase host", () => {
    const problems = validateConfig({ url: "https://example.com", anonKey: ANON });
    expect(problems.some((p) => /Supabase project URL/i.test(p.message))).toBe(true);
  });

  it("reports both fields when both are empty", () => {
    expect(validateConfig({ url: "", anonKey: "" }).map((p) => p.field)).toEqual(["url", "anonKey"]);
  });
});

describe("persistence", () => {
  it("round-trips through storage", () => {
    saveSupabaseConfig({ url: `${URL_OK}/`, anonKey: ` ${ANON} ` });
    resetConfigCache();
    expect(getSupabaseConfig()).toEqual({ url: URL_OK, anonKey: ANON });
  });

  it("survives a cache reset, as on restart", () => {
    saveSupabaseConfig({ url: URL_OK, anonKey: ANON });
    resetConfigCache();
    expect(hasSupabaseConfig()).toBe(true);
  });

  it("falls back to demo mode when cleared", () => {
    saveSupabaseConfig({ url: URL_OK, anonKey: ANON });
    clearSupabaseConfig();
    resetConfigCache();
    expect(hasSupabaseConfig()).toBe(false);
    expect(getSupabaseConfig()).toBeNull();
  });

  it("ignores a corrupt stored entry instead of crashing at boot", () => {
    storage.setItem("pos.supabase.config", "{not json");
    resetConfigCache();
    expect(getSupabaseConfig()).toBeNull();
  });

  it("ignores a stored entry missing a field", () => {
    storage.setItem("pos.supabase.config", JSON.stringify({ url: URL_OK }));
    resetConfigCache();
    expect(getSupabaseConfig()).toBeNull();
  });
});

describe("desktop-supplied project", () => {
  // A preconfigured installer hands the project over through the preload bridge, not through
  // NEXT_PUBLIC_* (which the bundler would bake into the website). These cover the precedence rules
  // that decide whether the till starts connected or in demo mode.
  const SHIPPED = { url: "https://shipped1234.supabase.co", anonKey: ANON };
  function withDesktop(config: { url: string; anonKey: string } | null) {
    vi.stubGlobal("window", { localStorage: storage, posDesktop: { config } });
    resetConfigCache();
  }
  it("starts connected when the installer supplies a project", () => {
    withDesktop(SHIPPED);
    expect(getSupabaseConfig()).toEqual(SHIPPED);
    expect(hasSupabaseConfig()).toBe(true);
    expect(isSupabaseConfigShipped()).toBe(true);
  });
  it("lets a project saved on this device win over the shipped one", () => {
    withDesktop(SHIPPED);
    saveSupabaseConfig({ url: URL_OK, anonKey: ANON });
    resetConfigCache();
    expect(getSupabaseConfig()).toEqual({ url: URL_OK, anonKey: ANON });
    expect(isSupabaseConfigShipped()).toBe(false);
  });
  it("stays disconnected after Disconnect is pressed, instead of restoring the shipped project", () => {
    withDesktop(SHIPPED);
    clearSupabaseConfig();
    resetConfigCache();
    expect(getSupabaseConfig()).toBeNull();
    expect(hasSupabaseConfig()).toBe(false);
    expect(isSupabaseConfigShipped()).toBe(false);
  });
  it("re-connects once a project is saved again after disconnecting", () => {
    withDesktop(SHIPPED);
    clearSupabaseConfig();
    saveSupabaseConfig({ url: URL_OK, anonKey: ANON });
    resetConfigCache();
    expect(getSupabaseConfig()).toEqual({ url: URL_OK, anonKey: ANON });
  });
  it("ignores an incomplete bridge payload", () => {
    withDesktop({ url: SHIPPED.url, anonKey: "" });
    expect(getSupabaseConfig()).toBeNull();
  });
  it("is inert in a browser, where there is no bridge", () => {
    resetConfigCache();
    expect(getSupabaseConfig()).toBeNull();
    expect(isSupabaseConfigShipped()).toBe(false);
  });
});
describe("connection test", () => {
  it("refuses to call the network with invalid input", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await testConnection({ url: "nope", anonKey: "nope" });
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a rejected key clearly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const result = await testConnection({ url: URL_OK, anonKey: ANON });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/key was rejected/i);
  });

  it("reports an unreachable host", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    const result = await testConnection({ url: URL_OK, anonKey: ANON });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not reach/i);
  });

  it("flags a reachable project with no schema applied", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: false, status: 404 }),
    );
    const result = await testConnection({ url: URL_OK, anonKey: ANON });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/schema is missing/i);
  });

  it("checks the key against auth, not against a table anon cannot read", async () => {
    // The bug this replaces: the probe hit PostgREST first. 0002 revokes every grant from anon, so
    // that call returns 42501 with a perfectly good key and setup said "the key was rejected".
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    await testConnection({ url: URL_OK, anonKey: ANON });
    const firstUrl = String(fetchSpy.mock.calls[0][0]);
    expect(firstUrl).toContain("/auth/v1/settings");
  });
  it("does not claim the schema was found before anyone signed in", async () => {
    // A 42501 from PostgREST proves nothing about the schema, so it must not be reported as success.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const result = await testConnection({ url: URL_OK, anonKey: ANON });
    expect(result.ok).toBe(true);
    expect(result.message).not.toMatch(/schema found/i);
    expect(result.message).toMatch(/sign in/i);
  });
  it("treats an RLS refusal as connected, not as a bad config", async () => {
    // An unauthenticated probe of a protected table is refused by design (401/403/42501). Reporting
    // that as a configuration error sends the shopkeeper hunting for a problem that does not exist.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: false, status: 401 }),
    );
    const result = await testConnection({ url: URL_OK, anonKey: ANON });
    expect(result.ok).toBe(true);
  });
});

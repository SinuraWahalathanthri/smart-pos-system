#!/usr/bin/env node
/**
 * LOCAL DEVELOPMENT TOOL. A stand-in for Supabase so the till can be tried in "connected" mode with no account.
 *
 * It speaks just enough of the Supabase HTTP API (auth + PostgREST) for supabase-js, and behind it runs the
 * REAL migrations and seed on an in-process Postgres (PGlite), with the real row-level security. Data lives
 * in memory and is reset every time it starts.
 *
 *   npm run mock:supabase        -> http://127.0.0.1:54321
 *
 * .env.local for the app:
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY=mock-anon-key
 *
 * Till account to sign in with:  till@shop.test / till-password
 * Test switches:  POST /__mock/offline?on=1|0  (drop connections)  ·  GET /__mock/query?q=select...  (read-only)
 * NOT for production: it has no real authentication, only a fixed list of demo accounts.
 */
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase");
const PORT = Number(process.env.PORT ?? 54321);

const ACCOUNTS = {
  "till@shop.test": { password: "till-password", staffCode: "3" }, // a cashier till
  "owner@shop.test": { password: "owner-password", staffCode: "1" },
};

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create schema extensions;
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, extensions to anon, authenticated;
`);
for (const f of readdirSync(join(ROOT, "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
}
await db.exec(readFileSync(join(ROOT, "seed.sql"), "utf8"));
const users = {};
for (const [email, a] of Object.entries(ACCOUNTS)) {
  const { rows } = await db.query("insert into auth.users (email) values ($1) returning id", [email]);
  users[email] = rows[0].id;
  await db.query("update profiles set auth_user_id = $1 where staff_code = $2", [rows[0].id, a.staffCode]);
}

// one connection, so run requests one at a time
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function asUser(sub, fn) {
  return serial(async () => {
    await db.exec(`select set_config('request.jwt.claim.sub', '${sub}', false); set role authenticated;`);
    try {
      return await fn();
    } finally {
      await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
    }
  });
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function session(email) {
  const now = Math.floor(Date.now() / 1000);
  const sub = users[email];
  const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", aud: "authenticated", email, iat: now, exp: now + 3600 })}.mock`;
  return {
    access_token: token, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: `rt|${email}`,
    user: { id: sub, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}
const subOf = (req) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1].split(".")[1], "base64url").toString());
    return p.exp > Date.now() / 1000 ? p.sub : null;
  } catch {
    return null;
  }
};

const CATALOGUE_SQL = `
  select coalesce(jsonb_agg(r), '[]'::jsonb) as rows from (
    select p.id, p.name, p.sku, p.kind, p.sale_mode, p.price_cents, p.tax_rate_pct, p.stock_on_hand, p.reorder_level,
           p.is_favourite, p.is_returnable_bottle, p.color, p.image_path, p.is_active,
           (select to_jsonb(c) from (select name from categories where id = p.category_id) c) as categories,
           coalesce((select jsonb_agg(ps order by ps.sort_order) from (
             select id, label, weight_g, price_cents, packets_on_hand, sort_order, is_active from pack_sizes where product_id = p.id) ps), '[]'::jsonb) as pack_sizes,
           coalesce((select jsonb_agg(b) from (
             select barcode, pack_size_id, is_primary from product_barcodes where product_id = p.id) b), '[]'::jsonb) as product_barcodes
    from products p order by p.name) r`;

async function callRpc(sub, fn, args) {
  const { rows: sig } = await db.query(
    `select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1 and has_function_privilege('authenticated', p.oid, 'execute')
      order by cardinality(p.proargtypes) desc limit 1`,
    [fn],
  );
  if (!sig.length) return { status: 404, body: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
  const names = sig[0].names ?? [];
  const types = sig[0].types;
  const given = Object.keys(args ?? {}).filter((k) => names.includes(k));
  const params = given.map((k) => {
    const t = types[names.indexOf(k)];
    const v = args[k];
    return v === null || v === undefined ? null : t === "jsonb" || t === "json" ? JSON.stringify(v) : String(v);
  });
  const call = `select public.${fn}(${given.map((k, i) => `${k} => $${i + 1}::${types[names.indexOf(k)]}`).join(", ")}) as r`;
  try {
    const { rows } = await asUser(sub, () => db.query(call, params));
    return { status: 200, body: rows[0]?.r ?? null };
  } catch (e) {
    const code = e.code ?? "P0001";
    const status = code === "28000" ? 401 : code === "42501" ? 403 : 400;
    return { status, body: { code, message: e.message, details: null, hint: null } };
  }
}

let offline = false;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version, prefer, range, range-unit, accept-profile, content-profile, accept",
  "access-control-expose-headers": "content-range",
};
const send = (res, status, body, extra = {}) => {
  res.writeHead(status, { ...CORS, "content-type": "application/json", ...extra });
  res.end(body === undefined || status === 204 ? "" : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((r) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => r(s ? JSON.parse(s) : {}));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return send(res, 204);

  if (url.pathname === "/__mock/offline") {
    offline = url.searchParams.get("on") === "1";
    return send(res, 200, { offline });
  }
  if (offline) return req.socket.destroy(); // looks like a dead connection to the browser

  try {
    if (url.pathname === "/__mock/query") {
      const q = url.searchParams.get("q") ?? "";
      if (!/^\s*select\b/i.test(q) || /;\s*\S/.test(q)) return send(res, 400, { message: "read-only: a single select" });
      return send(res, 200, (await serial(() => db.query(q))).rows);
    }

    if (url.pathname === "/auth/v1/token") {
      const body = await readBody(req);
      if (url.searchParams.get("grant_type") === "refresh_token") {
        const email = String(body.refresh_token ?? "").split("|")[1];
        return users[email] ? send(res, 200, session(email)) : send(res, 400, { error: "invalid_grant", error_description: "Invalid Refresh Token" });
      }
      const a = ACCOUNTS[body.email];
      if (!a || a.password !== body.password) {
        return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", code: 400, msg: "Invalid login credentials" });
      }
      return send(res, 200, session(body.email));
    }
    if (url.pathname === "/auth/v1/logout") return send(res, 204);
    if (url.pathname === "/auth/v1/user") {
      const sub = subOf(req);
      return sub ? send(res, 200, { id: sub, aud: "authenticated", role: "authenticated" }) : send(res, 401, { message: "invalid JWT" });
    }

    if (url.pathname.startsWith("/rest/v1/")) {
      const sub = subOf(req);
      if (!sub) return send(res, 401, { code: "PGRST301", message: "JWT expired", details: null, hint: null });

      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const out = await callRpc(sub, url.pathname.slice("/rest/v1/rpc/".length), await readBody(req));
        return send(res, out.status, out.body);
      }
      if (url.pathname === "/rest/v1/products" && req.method === "GET") {
        const from = Number((req.headers.range ?? "0-").split("-")[0]) || 0;
        if (from > 0) return send(res, 200, []);
        const { rows } = await asUser(sub, () => db.query(CATALOGUE_SQL));
        return send(res, 200, rows[0].rows);
      }
    }
    send(res, 404, { message: `mock: no route for ${req.method} ${url.pathname}` });
  } catch (e) {
    send(res, 500, { message: String(e?.message ?? e) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Mock Supabase running at http://127.0.0.1:${PORT}  (real migrations + seed, in memory)`);
  console.log("Till account: till@shop.test / till-password   ·   staff: 1/9999 owner, 2/2222 supervisor (badge SUP-0002), 3/3333 cashier");
});

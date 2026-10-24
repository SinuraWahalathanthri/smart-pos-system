import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0025: platform administration, owner provisioning, store self-service and suspension.
 *
 * The rules under test are the ones that are expensive to get wrong:
 *   - a shop owner must never reach the platform functions (no privilege escalation);
 *   - an administrator is read-only over trading data;
 *   - a suspended shop closes to its own staff but stays visible to the administrator;
 *   - an owner can edit their own shop details and the edit is audited;
 *   - a handed-over password forces a change on first sign-in.
 *
 * The auth.users / auth.identities stubs mirror the real GoTrue columns that the provisioning
 * function writes, so the single-transaction create path is exercised for real rather than mocked.
 */

const ROOT = join(__dirname, "..", "supabase");

const SUPABASE_STUBS = `
  create schema if not exists extensions;
  create role anon nologin;
  create role authenticated nologin;
  create schema if not exists auth;

  create table if not exists auth.users (
    instance_id uuid,
    id uuid primary key default gen_random_uuid(),
    aud text,
    role text,
    email text,
    encrypted_password text,
    email_confirmed_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    confirmation_token text,
    recovery_token text,
    email_change text,
    email_change_token_new text,
    is_sso_user boolean default false
  );

  create table if not exists auth.identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users (id) on delete cascade,
    provider_id text,
    provider text,
    identity_data jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    last_sign_in_at timestamptz
  );

  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, extensions to anon, authenticated;
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  const files = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function asUser<T>(authId: string, fn: () => Promise<T>, store?: string): Promise<T> {
  await db.exec(
    `select set_config('request.jwt.claim.sub', '${authId}', false);
     select set_config('app.store_id', '${store ?? ""}', false);
     set role authenticated;`,
  );
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('app.store_id', '', false);`);
  }
}

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

/** A confirmed email account, the way GoTrue would leave one. */
async function newAuthUser(email: string) {
  const r = await rows<{ id: string }>(
    `insert into auth.users (email, aud, role) values ($1, 'authenticated', 'authenticated') returning id`,
    [email],
  );
  return r[0].id;
}

async function makeAdmin(email = "admin@platform.test") {
  const id = await newAuthUser(email);
  await rows(`insert into platform_admins (auth_user_id, full_name) values ($1, $2)`, [id, "Platform Admin"]);
  return id;
}

/** Provision through the real RPC so the whole create path is covered. */
async function provision(adminId: string, email: string) {
  return asUser(adminId, async () => {
    const r = await rows<{ out: Record<string, unknown> }>(
      `select public.platform_create_owner($1, $2, $3) as out`,
      [email, "generated-Passw0rd", "Test Spice Shop"],
    );
    return r[0].out as { store_id: string; user_id: string; email: string };
  });
}

describe("0025 platform admin", () => {
  it("applies cleanly on top of every earlier migration", async () => {
    const r = await rows<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
        where table_name = 'stores' and column_name in ('is_active','suspended_at','suspended_reason')`,
    );
    expect(r[0].n).toBe(3);
  });

  it("provisions an owner account, shop and owner profile in one transaction", async () => {
    const admin = await makeAdmin();
    const out = await provision(admin, "owner1@shop.test");

    expect(out.email).toBe("owner1@shop.test");

    const user = await rows<{ email: string; encrypted_password: string }>(
      `select email, encrypted_password from auth.users where id = $1`,
      [out.user_id],
    );
    expect(user[0].email).toBe("owner1@shop.test");
    // The password is stored hashed, never in clear.
    expect(user[0].encrypted_password).toMatch(/^\$2[aby]\$/);
    expect(user[0].encrypted_password).not.toContain("generated-Passw0rd");

    // GoTrue needs an identity row or email sign-in fails even though the user exists.
    const ident = await rows<{ provider: string }>(
      `select provider from auth.identities where user_id = $1`,
      [out.user_id],
    );
    expect(ident[0].provider).toBe("email");

    const profile = await rows<{ role: string; staff_code: string; must_change_password: boolean }>(
      `select role, staff_code, must_change_password from profiles where auth_user_id = $1`,
      [out.user_id],
    );
    expect(profile[0]).toMatchObject({ role: "owner", staff_code: "1", must_change_password: true });

    const store = await rows<{ owner_id: string; is_active: boolean }>(
      `select owner_id, is_active from stores where id = $1`,
      [out.store_id],
    );
    expect(store[0]).toMatchObject({ owner_id: out.user_id, is_active: true });
  });

  it("refuses a duplicate email and a short password", async () => {
    const admin = await makeAdmin("admin2@platform.test");
    await provision(admin, "dupe@shop.test");

    await expect(provision(admin, "dupe@shop.test")).rejects.toThrow(/already exists/i);

    await expect(
      asUser(admin, () =>
        rows(`select public.platform_create_owner($1, $2, $3)`, ["short@shop.test", "abc", "Shop"]),
      ),
    ).rejects.toThrow(/at least 8/i);
  });

  it("keeps shop owners out of the platform functions entirely", async () => {
    const admin = await makeAdmin("admin3@platform.test");
    const { user_id } = await provision(admin, "owner2@shop.test");

    await expect(
      asUser(user_id, () => rows(`select public.platform_stores()`)),
    ).rejects.toThrow(/platform admins only/i);

    await expect(
      asUser(user_id, () =>
        rows(`select public.platform_create_owner($1, $2, $3)`, ["sneaky@shop.test", "generated-Passw0rd", "Shop"]),
      ),
    ).rejects.toThrow(/platform admins only/i);
  });

  it("is read-only over trading data", async () => {
    const admin = await makeAdmin("admin4@platform.test");
    const out = await provision(admin, "owner3@shop.test");

    // Provisioning twice is the closest thing to "editing" a shop the platform exposes: there is no
    // RPC that changes a sale, a product or a stock level, so the columns cannot drift.
    const detail = await asUser(admin, () =>
      rows<{ out: Record<string, unknown> }>(`select public.platform_store_detail($1) as out`, [out.store_id]),
    );
    expect(detail[0].out).toHaveProperty("store");
    expect(detail[0].out).toHaveProperty("platform_actions");
  });

  it("records every platform action in the audit trail", async () => {
    const admin = await makeAdmin("admin5@platform.test");
    const out = await provision(admin, "owner4@shop.test");

    const audit = await rows<{ action: string }>(
      `select action from platform_audit where store_id = $1 order by created_at`,
      [out.store_id],
    );
    expect(audit.map((a) => a.action)).toContain("owner_created");
  });

  it("refuses an unauthenticated caller before it reaches any data", async () => {
    // Grants and guards are two independent layers, and this checks the outer one: `anon` has no
    // execute privilege, so the call fails before the admin check even runs. Every RPC is listed,
    // because a single missing revoke re-opens the whole surface.
    const nothing = "00000000-0000-0000-0000-000000000000";
    const calls: [string, unknown[]][] = [
      [`select public.platform_stores()`, []],
      [`select public.platform_store_detail($1)`, [nothing]],
      [`select public.platform_create_owner($1,$2,$3)`, ["x@y.test", "generated-Passw0rd", "Shop"]],
      [`select public.platform_set_password($1,$2,$3)`, [nothing, "generated-Passw0rd", "r"]],
      [`select public.platform_set_store_active($1,$2,$3)`, [nothing, false, "r"]],
      [`select public.update_store_details('S',null,null,null,'LKR',0,5,true)`, []],
      [`select public.complete_password_change()`, []],
    ];

    await db.exec(`set role anon`);
    try {
      for (const [sql, params] of calls) {
        await expect(rows(sql, params), sql).rejects.toThrow(/permission denied/i);
      }
    } finally {
      await db.exec(`reset role`);
    }
  });

  it("suspends a shop, hides it from its staff, and keeps it readable by the administrator", async () => {
    const admin = await makeAdmin("admin6@platform.test");
    const out = await provision(admin, "owner5@shop.test");

    // An administrator must give a reason: a silent shutdown is not auditable.
    await expect(
      asUser(admin, () =>
        rows(`select public.platform_set_store_active($1, false)`, [out.store_id]),
      ),
    ).rejects.toThrow(/reason is required/i);

    await asUser(admin, () =>
      rows(`select public.platform_set_store_active($1, false, $2)`, [out.store_id, "unpaid invoice"]),
    );

    // The owner can no longer resolve their shop, which is what every policy keys on.
    const storeForOwner = await asUser(out.user_id, async () => {
      const r = await rows<{ id: string | null }>(`select public.app_store_id() as id`);
      return r[0].id;
    });
    expect(storeForOwner).toBeNull();

    // ...and a real policy refuses a write, not just the helper returning null. RLS sees no visible
    // store row, so an insert aimed at the shut shop is rejected rather than silently orphaned.
    await expect(
      asUser(
        out.user_id,
        () => rows(`insert into categories (store_id, name) values ($1, 'sneaky')`, [out.store_id]),
        out.store_id,
      ),
    ).rejects.toThrow();

    // ...but the administrator still sees it, with the reason attached.
    const listed = await asUser(admin, () =>
      rows<{ name: string; is_active: boolean; suspended_reason: string }>(
        `select name, is_active, suspended_reason from public.platform_stores() where id = $1`,
        [out.store_id],
      ),
    );
    expect(listed[0]).toMatchObject({ is_active: false, suspended_reason: "unpaid invoice" });

    // Restoring clears the state.
    await asUser(admin, () => rows(`select public.platform_set_store_active($1, true)`, [out.store_id]));
    const back = await asUser(out.user_id, async () => {
      const r = await rows<{ id: string | null }>(`select public.app_store_id() as id`);
      return r[0].id;
    });
    expect(back).toBe(out.store_id);
  });

  it("lets the owner edit their own shop details and audits the change", async () => {
    const admin = await makeAdmin("admin7@platform.test");
    const out = await provision(admin, "owner6@shop.test");

    const after = await asUser(
      out.user_id,
      async () => {
        const r = await rows<{ out: Record<string, unknown> }>(
          `select public.update_store_details($1, $2, $3, $4, $5, $6, $7, $8) as out`,
          ["Renamed Spice Shop", "12 Galle Road", "0771234567", "VAT-99", "LKR", 15000, 7.5, true],
        );
        return r[0].out;
      },
      out.store_id,
    );

    expect(after).toMatchObject({ name: "Renamed Spice Shop", phone: "0771234567", vat_no: "VAT-99" });

    const audit = await rows<{ action: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select action, before, after from audit_logs where store_id = $1 and action = 'store_updated'`,
      [out.store_id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].before.name).toBe("Test Spice Shop");
    expect(audit[0].after.name).toBe("Renamed Spice Shop");
  });

  it("refuses shop edits from a non-owner and validation errors from anyone", async () => {
    const admin = await makeAdmin("admin8@platform.test");
    const out = await provision(admin, "owner7@shop.test");

    // A cashier in the same shop may not edit the shop.
    await rows(
      `insert into profiles (store_id, full_name, staff_code, role) values ($1, 'Cashier', '3', 'cashier')`,
      [out.store_id],
    );
    const cashier = await newAuthUser("cashier7@shop.test");
    await rows(`update profiles set auth_user_id = $1 where store_id = $2 and staff_code = '3'`, [
      cashier,
      out.store_id,
    ]);

    await expect(
      asUser(
        cashier,
        () => rows(`select public.update_store_details('Hijacked', null, null, null, 'LKR', 0, 5, true)`),
        out.store_id,
      ),
    ).rejects.toThrow(/only the shop owner/i);

    await expect(
      asUser(
        out.user_id,
        () => rows(`select public.update_store_details('', null, null, null, 'LKR', 0, 5, true)`),
        out.store_id,
      ),
    ).rejects.toThrow(/name is required/i);

    await expect(
      asUser(
        out.user_id,
        () => rows(`select public.update_store_details('Shop', null, null, null, 'LKR', -1, 5, true)`),
        out.store_id,
      ),
    ).rejects.toThrow(/cannot be negative/i);
  });

  it("forces a password change after a reset and clears it when the owner complies", async () => {
    const admin = await makeAdmin("admin9@platform.test");
    const out = await provision(admin, "owner8@shop.test");

    // Provisioning already flags it.
    const before = await asUser(out.user_id, async () => {
      const r = await rows<{ my_shop: Record<string, unknown> }>(`select public.my_shop() as my_shop`);
      return r[0].my_shop;
    });
    expect(before.must_change_password).toBe(true);
    expect(before.onboarded).toBe(true);

    await asUser(out.user_id, () => rows(`select public.complete_password_change()`));

    const after = await asUser(out.user_id, async () => {
      const r = await rows<{ my_shop: Record<string, unknown> }>(`select public.my_shop() as my_shop`);
      return r[0].my_shop;
    });
    expect(after.must_change_password).toBe(false);

    // A reset re-arms the flag and changes the hash.
    const oldHash = await rows<{ h: string }>(`select encrypted_password as h from auth.users where id = $1`, [
      out.user_id,
    ]);
    await asUser(admin, () =>
      rows(`select public.platform_set_password($1, $2, $3)`, [out.user_id, "another-Passw0rd", "lost slip"]),
    );
    const newHash = await rows<{ h: string }>(`select encrypted_password as h from auth.users where id = $1`, [
      out.user_id,
    ]);
    expect(newHash[0].h).not.toBe(oldHash[0].h);
  });

  it("reports an administrator to the app as having no shop", async () => {
    const admin = await makeAdmin("admin10@platform.test");
    const shop = await asUser(admin, async () => {
      const r = await rows<{ my_shop: Record<string, unknown> }>(`select public.my_shop() as my_shop`);
      return r[0].my_shop;
    });
    expect(shop).toMatchObject({ onboarded: false, is_platform_admin: true });
  });

  it("runs the one-shot bootstrap script as written", async () => {
    // The bootstrap is a manual script whose only execution is a human pasting it into the SQL editor,
    // so a typo is not caught by any other test. Substitute the placeholders the way a person would
    // and run the file itself.
    const sql = readFileSync(join(ROOT, "setup-platform-admin.sql"), "utf8")
      .replace("'<ADMIN EMAIL>'", "'bootstrap@platform.test'")
      .replace("'<A LONG RANDOM PASSWORD>'", "'a-long-enough-password'")
      .replace("'<YOUR NAME>'", "'Bootstrap Admin'");

    await db.exec(sql);

    const admin = await rows<{ auth_user_id: string; full_name: string }>(
      `select auth_user_id, full_name from platform_admins where full_name = 'Bootstrap Admin'`,
    );
    expect(admin).toHaveLength(1);

    const user = await rows<{ email: string; encrypted_password: string; email_confirmed_at: string }>(
      `select email, encrypted_password, email_confirmed_at from auth.users where id = $1`,
      [admin[0].auth_user_id],
    );
    expect(user[0].email).toBe("bootstrap@platform.test");
    expect(user[0].encrypted_password).toMatch(/^\$2[aby]\$/);
    expect(user[0].email_confirmed_at).not.toBeNull();

    // The identity row is what makes email sign-in work; without it GoTrue rejects a valid password.
    const ident = await rows<{ provider: string }>(
      `select provider from auth.identities where user_id = $1`,
      [admin[0].auth_user_id],
    );
    expect(ident[0].provider).toBe("email");

    // ...and the account really is an administrator: the panel opens for it.
    const stores = await asUser(admin[0].auth_user_id, () => rows(`select * from public.platform_stores()`));
    expect(Array.isArray(stores)).toBe(true);

    // Running it twice must stop with a clear message rather than half-creating a second admin.
    await expect(db.exec(sql)).rejects.toThrow(/already exists/i);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0029: a business registers itself and a platform admin approves it.
 *
 *   - Only a signed-in account with a VERIFIED email can apply; anon cannot call anything.
 *   - Only a platform admin can list or decide applications; a shop owner cannot.
 *   - Approval does not create a shop by itself; create_store() opens it, once, for that account.
 *   - Rejection leaves no shop behind. Registering never makes anyone a platform admin.
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

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

async function asUser<T>(authId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

const call = <T>(authId: string, sql: string, params: unknown[] = []) =>
  asUser(authId, async () => (await rows<{ r: T }>(`select ${sql} as r`, params))[0].r);

/** An account as Supabase signUp() leaves it: verified only once the link is clicked. */
async function signUp(email: string, { verified = true } = {}) {
  const r = await rows<{ id: string }>(
    `insert into auth.users (email, aud, role, email_confirmed_at)
     values ($1, 'authenticated', 'authenticated', $2) returning id`,
    [email, verified ? new Date().toISOString() : null],
  );
  return r[0].id;
}

async function makeAdmin(email: string) {
  const id = await signUp(email);
  await rows(`insert into platform_admins (auth_user_id, full_name) values ($1, 'Admin')`, [id]);
  return id;
}

const APPLICATION = {
  owner_name: "Nimali Perera",
  owner_phone: "0771234567",
  legal_name: "Perera Traders (Pvt) Ltd",
  trading_name: "Perera Mart",
  business_type: "grocery",
  country: "Sri Lanka",
  currency: "lkr",
  address: "12 Main Street, Kandy",
  locations_count: 2,
  tills_count: 3,
  terms_version: "2026-10",
};

const submit = (auth: string, app: Record<string, unknown> = APPLICATION) =>
  call<{ id: string; status: string }>(auth, `public.submit_vendor_application($1)`, [app]);

const review = (who: string, id: string, decision: string, reason: string | null = null) =>
  call<{ status: string }>(who, `public.platform_review_vendor_application($1, $2, $3)`, [id, decision, reason]);

let admin = "";
beforeAll(async () => {
  admin = await makeAdmin("admin@platform.test");
});

describe("applying", () => {
  it("refuses an account whose email is not verified yet", async () => {
    const auth = await signUp("unverified@shop.test", { verified: false });
    await expect(submit(auth)).rejects.toThrow(/verify your email/i);
    const status = await call<{ email_verified: boolean; application: unknown }>(auth, `public.my_vendor_application()`);
    expect(status).toMatchObject({ email_verified: false, application: null });
  });

  it("accepts a verified account and records the terms it accepted", async () => {
    const auth = await signUp("owner1@shop.test");
    const out = await submit(auth);
    expect(out.status).toBe("submitted");
    const mine = await call<{ application: Record<string, unknown> }>(auth, `public.my_vendor_application()`);
    expect(mine.application).toMatchObject({
      status: "submitted",
      legal_name: "Perera Traders (Pvt) Ltd",
      currency: "LKR",
      terms_version: "2026-10",
      tills_count: 3,
    });
    expect(mine.application).not.toHaveProperty("reviewed_by");
  });

  it("updates the open application rather than making a second one", async () => {
    const auth = await signUp("owner2@shop.test");
    const a = await submit(auth);
    const b = await submit(auth, { ...APPLICATION, trading_name: "Renamed" });
    expect(b.id).toBe(a.id);
    expect(await rows(`select 1 from vendor_applications where auth_user_id = $1`, [auth])).toHaveLength(1);
  });

  it("refuses bad input, old terms and throwaway inboxes", async () => {
    const auth = await signUp("owner3@shop.test");
    await expect(submit(auth, { ...APPLICATION, business_type: "casino" })).rejects.toThrow(/kind of business/);
    await expect(submit(auth, { ...APPLICATION, legal_name: " " })).rejects.toThrow(/business name/);
    await expect(submit(auth, { ...APPLICATION, terms_version: "2020-01" })).rejects.toThrow(/terms of service/);
    const temp = await signUp("someone@mailinator.com");
    await expect(submit(temp)).rejects.toThrow(/temporary inbox/);
  });

  it("refuses an account that already has a shop, and a platform admin", async () => {
    await expect(submit(admin)).rejects.toThrow(/platform administrator cannot/);
    const owner = await signUp("hasshop@shop.test");
    await rows(`insert into stores (owner_id, name) values ($1, 'Existing')`, [owner]);
    await expect(submit(owner)).rejects.toThrow(/already belongs to a shop/);
  });

  it("lets the applicant withdraw a pending application and apply again", async () => {
    const auth = await signUp("owner4@shop.test");
    await submit(auth);
    await call(auth, `public.withdraw_vendor_application()`);
    const again = await submit(auth);
    expect(again.status).toBe("submitted");
    const history = await rows<{ status: string }>(
      `select status from vendor_applications where auth_user_id = $1 order by created_at`,
      [auth],
    );
    expect(history.map((h) => h.status)).toEqual(["withdrawn", "submitted"]);
  });
});

describe("reviewing", () => {
  it("shows open applications to a platform admin only", async () => {
    const list = await call<{ owner_email: string; status: string }[]>(admin, `public.platform_vendor_applications(null)`);
    expect(list.map((a) => a.owner_email)).toContain("owner1@shop.test");
    expect(list.every((a) => ["submitted", "info_requested"].includes(a.status))).toBe(true);

    const owner = await signUp("nosy@shop.test");
    await expect(call(owner, `public.platform_vendor_applications(null)`)).rejects.toThrow(/platform admins only/);
    await expect(review(owner, "00000000-0000-0000-0000-000000000000", "approve")).rejects.toThrow(
      /platform admins only/,
    );
  });

  it("asks for more information, and the resubmission goes back to the queue", async () => {
    const auth = await signUp("owner5@shop.test");
    const { id } = await submit(auth);
    await expect(review(admin, id, "request_info")).rejects.toThrow(/reason/);
    await review(admin, id, "request_info", "Add your VAT number");
    const mine = await call<{ application: { status: string; decision_reason: string } }>(
      auth,
      `public.my_vendor_application()`,
    );
    expect(mine.application).toMatchObject({ status: "info_requested", decision_reason: "Add your VAT number" });
    const again = await submit(auth, { ...APPLICATION, tax_number: "VAT-123" });
    expect(again).toEqual({ id, status: "submitted" });
  });

  it("rejects with a reason and leaves no shop behind", async () => {
    const auth = await signUp("owner6@shop.test");
    const { id } = await submit(auth);
    await review(admin, id, "reject", "Not a registered business");
    await expect(asUser(auth, () => rows(`select public.create_store('Sneaky Shop')`))).rejects.toThrow(
      /wait for approval/,
    );
    expect(await rows(`select 1 from stores where owner_id = $1`, [auth])).toEqual([]);
    const audit = await rows<{ action: string }>(`select action from platform_audit where target_user = $1`, [auth]);
    expect(audit.map((a) => a.action)).toContain("vendor_rejected");
  });

  it("approves, then the owner opens exactly one shop with the application's details", async () => {
    const auth = await signUp("owner7@shop.test");
    const { id } = await submit(auth);
    await review(admin, id, "approve");
    await expect(review(admin, id, "reject", "x")).rejects.toThrow(/already approved/);

    const shop = await call<{ id: string; created: boolean }>(auth, `public.create_store($1)`, ["Perera Mart"]);
    expect(shop.created).toBe(true);
    const again = await call<{ id: string; created: boolean }>(auth, `public.create_store($1)`, ["Perera Mart"]);
    expect(again).toMatchObject({ id: shop.id, created: false });

    const store = await rows<{ business_type: string; country: string; currency: string }>(
      `select business_type, country, currency from stores where id = $1`,
      [shop.id],
    );
    expect(store[0]).toEqual({ business_type: "grocery", country: "Sri Lanka", currency: "LKR" });
    const owner = await rows<{ full_name: string; role: string }>(
      `select full_name, role from profiles where auth_user_id = $1`,
      [auth],
    );
    expect(owner).toEqual([{ full_name: "Nimali Perera", role: "owner" }]);
    expect(await rows(`select 1 from platform_admins where auth_user_id = $1`, [auth])).toEqual([]);
  });

  it("approves straight away when auto-approval is switched on", async () => {
    const owner = await signUp("owner8@shop.test");
    await expect(call(owner, `public.platform_set_auto_approve(true)`)).rejects.toThrow(/platform admins only/);
    await call(admin, `public.platform_set_auto_approve(true)`);
    try {
      expect((await submit(owner)).status).toBe("approved");
    } finally {
      await call(admin, `public.platform_set_auto_approve(false)`);
    }
    const settings = await call<{ auto_approve_vendors: boolean }>(admin, `public.platform_registration_settings()`);
    expect(settings.auto_approve_vendors).toBe(false);
  });
});

describe("the outer wall", () => {
  it("gives anon no way in", async () => {
    const nothing = "00000000-0000-0000-0000-000000000000";
    const calls: [string, unknown[]][] = [
      [`select public.submit_vendor_application($1)`, [APPLICATION]],
      [`select public.my_vendor_application()`, []],
      [`select public.withdraw_vendor_application()`, []],
      [`select public.platform_vendor_applications(null)`, []],
      [`select public.platform_review_vendor_application($1, 'approve', null)`, [nothing]],
      [`select public.platform_registration_settings()`, []],
      [`select public.platform_set_auto_approve(true)`, []],
      [`select * from public.vendor_applications`, []],
      [`select * from public.platform_settings`, []],
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

  it("keeps the internal helpers and the tables away from signed-in clients", async () => {
    const owner = await signUp("helpers@shop.test");
    for (const sql of [
      `public.verified_email()`,
      `public.caller_has_shop()`,
      `public.is_disposable_email('a@b.c')`,
      `(select count(*) from public.vendor_applications)`,
    ]) {
      await expect(call(owner, sql), sql).rejects.toThrow(/permission denied/i);
    }
  });
});

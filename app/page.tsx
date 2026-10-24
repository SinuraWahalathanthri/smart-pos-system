"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSupabase, isConnected } from "@/lib/supabase/client";
/**
 * Entry point. Decides where a person lands, once, in one place.
 *
 *   not configured   -> /setup        (paste the project URL and anon key)
 *   no session       -> /login
 *   password handed over but unchanged -> /account?first=1
 *   no shop yet      -> /platform     (a platform administrator) or /onboarding (a new owner)
 *   a shop exists    -> /dashboard    (the till is one click away from there)
 *
 * The server answers these through my_shop(), so this decides from the database rather than from
 * anything cached in the browser.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    void (async () => {
      if (!isConnected()) {
        router.replace("/setup");
        return;
      }
      try {
        const sb = getSupabase();
        const { data } = await sb.auth.getSession();
        if (!data.session) {
          router.replace("/login");
          return;
        }
        const { data: shop } = await sb.rpc("my_shop");
        const ctx = shop as
          | { onboarded?: boolean; is_platform_admin?: boolean; must_change_password?: boolean }
          | null;
        if (ctx?.onboarded && ctx.must_change_password) {
          router.replace("/account?first=1");
          return;
        }
        if (ctx?.onboarded) {
          router.replace("/dashboard");
          return;
        }
        router.replace(ctx?.is_platform_admin ? "/platform" : "/onboarding");
      } catch {
        router.replace("/setup");
      }
    })();
  }, [router]);
  return (
    <main className="grid min-h-dvh place-items-center text-muted">
      <p>Starting...</p>
    </main>
  );
}

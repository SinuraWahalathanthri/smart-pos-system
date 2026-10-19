"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSupabase, isConnected } from "@/lib/supabase/client";
/**
 * Entry point. Decides where a person lands, once, in one place.
 *
 *   not configured   -> /setup        (paste the project URL and anon key)
 *   no session       -> /login
 *   no shop yet      -> /onboarding   (the owner names their shop)
 *   a shop exists    -> /dashboard    (the till is one click away from there)
 *
 * The server answers "is there a shop?" through my_shop(), so this decides from the database rather
 * than from anything cached in the browser.
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
        router.replace((shop as { onboarded?: boolean } | null)?.onboarded ? "/dashboard" : "/onboarding");
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

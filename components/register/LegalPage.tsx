import Link from "next/link";
import { PLATFORM_NAME } from "@/lib/registration";

/**
 * Shell for /terms and /privacy.
 *
 * The text is a DRAFT outline written by the developers, not legal advice. The operator must replace
 * it with terms reviewed for their country before opening registration to the public, and bump
 * platform_settings.terms_version so every applicant accepts the new version.
 */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh px-4 py-10">
      <article className="mx-auto max-w-2xl space-y-4 text-sm leading-relaxed">
        <Link href="/" className="text-sm text-primary hover:underline">
          ← {PLATFORM_NAME}
        </Link>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="rounded-lg border border-warning/40 bg-warning/10 p-3">
          Draft. This outline has not been reviewed by a lawyer and will be replaced before public launch.
        </p>
        {children}
      </article>
    </main>
  );
}

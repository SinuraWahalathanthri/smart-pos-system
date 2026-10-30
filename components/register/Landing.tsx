"use client";

import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Boxes,
  ScanLine,
  ShieldCheck,
  Store,
  Users,
  WifiOff,
} from "lucide-react";
import { BUSINESS_TYPES, PLATFORM_NAME } from "@/lib/registration";

const FEATURES = [
  { Icon: ScanLine, title: "Fast checkout", text: "Barcode-first, keyboard shortcuts for every action, and a touch layout for phones and tablets." },
  { Icon: WifiOff, title: "Keeps selling offline", text: "Sales are saved on the till and upload when the connection comes back." },
  { Icon: Boxes, title: "Stock you can trust", text: "Every movement is recorded: deliveries, sales, refunds, damage and counts." },
  { Icon: Users, title: "Staff and approvals", text: "Cashiers, supervisors and owners, with badge + PIN approval for voids and discounts." },
  { Icon: BarChart3, title: "Finance built in", text: "Profit, expenses, supplier bills, customer credit and tax records in one place." },
  { Icon: ShieldCheck, title: "Your data, your shop", text: "Each business is sealed off from every other, and the audit trail cannot be edited." },
];

const STEPS = [
  { n: 1, title: "Create your account", text: "Your name, email and a password. We send a link to confirm the email." },
  { n: 2, title: "Tell us about the business", text: "What you sell, where, and how many tills. It takes about two minutes." },
  { n: 3, title: "Start selling", text: "Once approved, name your shop, add products and staff, and open the till." },
];

/**
 * The public front door, shown at / to visitors who are not signed in (website only: the installed
 * till goes straight to its sign-in). Everything here is static; the first network call happens on
 * /register or /login.
 */
export function Landing() {
  return (
    <main className="min-h-dvh bg-bg text-text">
      <header className="border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-fg">
            <Store size={18} />
          </span>
          <span className="mr-auto text-base font-semibold">{PLATFORM_NAME}</span>
          <Link href="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text">
            Sign in
          </Link>
          <Link
            href="/register"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-fg hover:brightness-110"
          >
            Register your business
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pb-12 pt-14 sm:pt-20">
        <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Point of sale for every kind of shop</p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight sm:text-5xl">
          Run the counter, the stock and the books from one place.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted">
          {PLATFORM_NAME} works for a corner shop with one till and for a business with several branches. Register,
          and you can be selling the same day.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            href="/register"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-fg hover:brightness-110"
          >
            Register your business <ArrowRight size={16} />
          </Link>
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-lg border border-border bg-surface px-5 text-sm font-semibold hover:bg-surface-2"
          >
            I already have an account
          </Link>
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className="mx-auto grid max-w-6xl gap-px px-4 py-10 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ Icon, title, text }) => (
            <div key={title} className="p-4">
              <Icon className="mb-3 text-primary" size={22} />
              <h2 className="font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-muted">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12">
        <h2 className="text-2xl font-semibold">Made for your kind of business</h2>
        <p className="mt-1 text-muted">Pick yours when you register. You can change what the till shows later.</p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {BUSINESS_TYPES.filter((b) => b.id !== "other").map((b) => (
            <div key={b.id} className="rounded-xl border border-border bg-surface p-4">
              <p className="font-medium">{b.label}</p>
              <p className="mt-0.5 text-sm text-muted">{b.hint}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-12">
          <h2 className="text-2xl font-semibold">How registration works</h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-xl border border-border p-4">
                <span className="mb-3 grid h-8 w-8 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                  {s.n}
                </span>
                <p className="font-medium">{s.title}</p>
                <p className="mt-1 text-sm text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-muted">
            Every new business is reviewed before it can trade, so the platform stays free of fake shops.
          </p>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-6 text-sm text-muted">
        <span className="mr-auto">© {new Date().getFullYear()} {PLATFORM_NAME}</span>
        <Link href="/terms" className="hover:text-text">Terms of service</Link>
        <Link href="/privacy" className="hover:text-text">Privacy</Link>
      </footer>
    </main>
  );
}

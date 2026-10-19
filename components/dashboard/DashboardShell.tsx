"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Boxes, LayoutDashboard, LogOut, Receipt, ShoppingCart, Store, Users, UserRound, Wallet } from "lucide-react";
import { useShop, permissions, type Role } from "./useShop";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, needs: "viewAnalytics" as const },
  { href: "/receipts", label: "Receipts", icon: Receipt, needs: "viewAnalytics" as const },
  { href: "/customers", label: "Customers", icon: UserRound, needs: "viewAnalytics" as const },
  { href: "/credit", label: "Credit", icon: Wallet, needs: "manageCredit" as const },
  { href: "/products", label: "Products", icon: Boxes, needs: "manageProducts" as const },
  { href: "/staff", label: "Staff", icon: Users, needs: "manageStaff" as const },
];

/**
 * The frame around every dashboard screen.
 *
 * The navigation is filtered by role, so a cashier never sees Products or Staff. That is courtesy,
 * not security: the RPCs refuse the call regardless of what the browser renders.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { ctx, loading, error, signOut, switchStore } = useShop();
  const role = ctx?.role;
  const can = permissions(role);

  if (loading) {
    return <Centered>Loading your shop...</Centered>;
  }
  if (error) {
    return (
      <Centered>
        <p className="text-danger">{error}</p>
        <button className="mt-3 text-sm underline" onClick={() => location.reload()}>
          Try again
        </button>
      </Centered>
    );
  }
  if (!ctx?.store) return null;

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-fg">
              <Store size={18} />
            </span>
            <div className="leading-tight">
              <p className="font-semibold">{ctx.store.name}</p>
              <p className="text-xs capitalize text-muted">{role}</p>
            </div>
          </div>

          {(ctx.stores?.length ?? 0) > 1 && (
            <select
              className="field w-auto"
              value={ctx.store.id}
              onChange={(e) => void switchStore(e.target.value)}
              aria-label="Switch shop"
            >
              {ctx.stores!.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}

          <nav className="flex flex-1 items-center gap-1">
            {NAV.filter((n) => can[n.needs]).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  pathname === href ? "bg-primary-soft text-primary" : "text-muted hover:bg-surface-2"
                }`}
              >
                <Icon size={16} />
                {label}
              </Link>
            ))}
          </nav>

          <button
            onClick={() => router.push("/pos")}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg"
          >
            <ShoppingCart size={16} />
            Open till
          </button>
          <button
            onClick={() => void signOut()}
            className="rounded-lg p-2 text-muted hover:bg-surface-2"
            aria-label="Sign out"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

/** Shown when a signed-in user opens a screen their role may not use. */
export function NotAllowed({ what, role }: { what: string; role: Role | undefined }) {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-border bg-surface p-6 text-center">
      <BarChart3 className="mx-auto mb-3 text-warning" size={26} />
      <h2 className="font-semibold">Not available for your role</h2>
      <p className="mt-1 text-sm text-muted">
        A {role ?? "user"} cannot manage {what}. Ask the shop owner.
      </p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-6 text-center text-muted">{children}</div>;
}

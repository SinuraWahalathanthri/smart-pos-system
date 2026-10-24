"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  Boxes,
  Building2,
  ClipboardCheck,
  Factory,
  LayoutDashboard,
  LogOut,
  Menu,
  Pencil,
  Receipt,
  ReceiptText,
  ShieldCheck,
  ShoppingCart,
  Store,
  TrendingUp,
  Truck,
  Users,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import { useShop, permissions, type Role } from "./useShop";
import { ShopDetailsDialog } from "./ShopDetailsDialog";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Boxes;
  needs: keyof ReturnType<typeof permissions>;
  /** Kept in the header; everything else lives in the menu. */
  primary?: boolean;
};

/**
 * The dashboard navigation, grouped so the list stays readable as the back office grows.
 *
 * A group whose items are all hidden by role disappears entirely rather than leaving an empty heading.
 * The filtering is cosmetic; every RPC checks the role again.
 */
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Shop",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard, needs: "viewAnalytics", primary: true },
      { href: "/receipts", label: "Receipts", icon: Receipt, needs: "viewAnalytics" },
      { href: "/customers", label: "Customers", icon: UserRound, needs: "viewAnalytics", primary: true },
      { href: "/credit", label: "Credit", icon: Wallet, needs: "manageCredit" },
    ],
  },
  {
    group: "Stock",
    items: [
      { href: "/products", label: "Products", icon: Boxes, needs: "manageProducts", primary: true },
      { href: "/production", label: "Production", icon: Factory, needs: "viewAnalytics" },
      { href: "/purchases", label: "Purchases", icon: Truck, needs: "viewAnalytics" },
    ],
  },
  {
    group: "Money",
    items: [
      { href: "/finance", label: "Finance", icon: TrendingUp, needs: "viewAnalytics", primary: true },
      { href: "/expenses", label: "Expenses", icon: ReceiptText, needs: "viewAnalytics" },
      { href: "/profitability", label: "Profitability", icon: BarChart3, needs: "viewAnalytics" },
      { href: "/tax", label: "Tax", icon: ClipboardCheck, needs: "viewAnalytics" },
    ],
  },
  {
    group: "Admin",
    items: [
      { href: "/staff", label: "Staff", icon: Users, needs: "manageStaff" },
      { href: "/audit", label: "Audit", icon: ShieldCheck, needs: "viewAudit" },
    ],
  },
  // Only drawn for a platform administrator. Kept last and deliberately un-primary: it is about the
  // installation, not about running this shop's day.
  {
    group: "Platform",
    items: [{ href: "/platform", label: "All shops", icon: Building2, needs: "managePlatform" }],
  },
];

/** The full, role-filtered menu, grouped. A group with nothing left to show is dropped. */
function useVisibleNav(can: ReturnType<typeof permissions>) {
  return NAV.map(({ group, items }) => ({ group, items: items.filter((n) => can[n.needs]) })).filter(
    (g) => g.items.length > 0,
  );
}

/**
 * Every screen the role may use, grouped. The header only carries the few `primary` ones, so the
 * back office stays legible as screens are added.
 */
function NavMenu({ groups }: { groups: ReturnType<typeof useVisibleNav> }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // Following a link leaves the menu behind, otherwise it hides the screen just opened.

  if (groups.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Menu"}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text"
      >
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>
      {open && (
        <div
          role="menu"
          className="pop-in absolute right-0 top-full z-30 mt-2 max-h-[80vh] w-64 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-[var(--shadow)]"
        >
          {groups.map(({ group, items }) => (
            <div key={group} className="mb-1 last:mb-0">
              <p className="px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-muted">{group}</p>
              {items.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${
                    pathname === href ? "bg-primary-soft text-primary" : "text-muted hover:bg-surface-2"
                  }`}
                >
                  <Icon size={15} />
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The frame around every dashboard screen.
 *
 * The navigation is filtered by role, so a cashier never sees Products or Staff. That is courtesy,
 * not security: the RPCs refuse the call regardless of what the browser renders.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { ctx, loading, error, signOut, switchStore, reload } = useShop();
  const [editingShop, setEditingShop] = useState(false);
  const role = ctx?.role;
  const can = permissions(role, ctx?.is_platform_admin);
  const groups = useVisibleNav(can);

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
  // Onboarded but shut by a platform administrator. This is not the same as "no shop yet": the data
  // still exists, so it must not fall through to the onboarding flow and offer to create a new shop.
  if (ctx?.suspended) {
    return (
      <Centered>
        <div className="max-w-md text-center">
          <ShieldCheck className="mx-auto mb-3 text-warning" size={28} />
          <h2 className="font-semibold">This shop is closed</h2>
          <p className="mt-1 text-sm text-muted">
            {ctx.store?.name ?? "Your shop"} has been suspended
            {ctx.suspended_reason ? `: ${ctx.suspended_reason}` : "."}
          </p>
          <p className="mt-3 text-sm text-muted">Contact your supplier to reopen it. Your data is safe.</p>
          <button className="mt-4 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
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
            {role === "owner" && (
              <button
                onClick={() => setEditingShop(true)}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-2"
                aria-label="Edit shop details"
                title="Edit shop details"
              >
                <Pencil size={15} />
              </button>
            )}
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

          <nav className="flex flex-1 flex-wrap items-center gap-1">
            {groups.map(({ items }) => {
              const shown = items.filter((n) => n.primary);
              if (shown.length === 0) return null;
              return shown.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm ${
                    pathname === href ? "bg-primary-soft text-primary" : "text-muted hover:bg-surface-2"
                  }`}
                >
                  <Icon size={15} />
                  {label}
                </Link>
              ));
            })}
          </nav>

          <NavMenu groups={groups} />

          <button
            onClick={() => router.push("/pos")}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg"
          >
            <ShoppingCart size={16} />
            Open till
          </button>
          <Link
            href="/account"
            className="rounded-lg p-2 text-muted hover:bg-surface-2"
            aria-label="Your account"
            title="Your account"
          >
            <UserRound size={18} />
          </Link>
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

      {editingShop && ctx.store && (
        <ShopDetailsDialog
          shop={ctx.store}
          onClose={() => setEditingShop(false)}
          onSaved={() => {
            setEditingShop(false);
            void reload();
          }}
        />
      )}
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

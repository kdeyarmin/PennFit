import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useDashboardIdentity } from "@/lib/admin/identity";
import { BrandHeader, BrandFooter } from "./BrandHeader";
import { GlobalLookup } from "./GlobalLookup";
import { RoleProvider, type AdminRole } from "@/lib/admin/role-context";
import { clearAllDrafts } from "@/lib/admin/use-draft-autosave";

// Console chrome: brand header + sidebar nav + footer + content slot.
// Used by every signed-in admin screen so layout, brand chrome,
// and the active-route indicator stay in lockstep across pages.
//
// Active-route detection uses wouter's `useLocation`. The
// pathname returned by `useLocation` is RELATIVE to the wouter
// `<Router base>` set in App.tsx, which is the artifact's base path
// (e.g. "/resupply"). So a NAV_LINK href of "/patients" matches a
// `location` of "/patients" or "/patients/<id>" — the prefix check
// handles the detail-page case so deep links keep the right link
// highlighted.

const NAV_LINKS: ReadonlyArray<{
  href: string;
  label: string;
  matchPrefix?: string;
}> = [
  { href: "/admin", label: "Dashboard", matchPrefix: "/admin" },
  { href: "/admin/patients", label: "Patients", matchPrefix: "/admin/patients" },
  {
    href: "/admin/conversations",
    label: "Conversations",
    matchPrefix: "/admin/conversations",
  },
  { href: "/admin/episodes", label: "Episodes", matchPrefix: "/admin/episodes" },
  { href: "/admin/rules", label: "Rules", matchPrefix: "/admin/rules" },
  { href: "/admin/audit", label: "Audit", matchPrefix: "/admin/audit" },
  {
    href: "/admin/shop/reviews",
    label: "Shop Reviews",
    matchPrefix: "/admin/shop/reviews",
  },
  {
    href: "/admin/shop/inventory",
    label: "Shop Inventory",
    matchPrefix: "/admin/shop/inventory",
  },
  {
    href: "/admin/shop/abandoned-carts",
    label: "Abandoned Carts",
    matchPrefix: "/admin/shop/abandoned-carts",
  },
  {
    href: "/admin/shop/insurance-leads",
    label: "Insurance Leads",
    matchPrefix: "/admin/shop/insurance-leads",
  },
  {
    href: "/admin/shop/returns",
    label: "Returns & RMAs",
    matchPrefix: "/admin/shop/returns",
  },
  {
    href: "/admin/macros",
    label: "Canned Replies",
    matchPrefix: "/admin/macros",
  },
  {
    href: "/admin/shop/subscriptions",
    label: "Subscription Health",
    matchPrefix: "/admin/shop/subscriptions",
  },
  {
    href: "/admin/team",
    label: "Team",
    matchPrefix: "/admin/team",
  },
  {
    href: "/admin/operations",
    label: "Operations",
    matchPrefix: "/admin/operations",
  },
  {
    href: "/admin/reports",
    label: "Reports",
    matchPrefix: "/admin/reports",
  },
  {
    href: "/admin/delivery-failures",
    label: "Delivery Failures",
    matchPrefix: "/admin/delivery-failures",
  },
  {
    href: "/admin/rule-tester",
    label: "Rule Tester",
    matchPrefix: "/admin/rule-tester",
  },
  {
    href: "/admin/settings",
    label: "Settings",
    matchPrefix: "/admin/settings",
  },
  // PennPaps storefront-admin pages — ported from cpap-fitter as
  // part of the Task #37 consolidation. Kept under their own
  // `/admin/pennpaps/*` namespace so they don't visually collide
  // with the existing cash-pay shop admin (`/admin/shop/*`) or
  // the resupply audit log at `/audit` (which is a different
  // table — `resupply.audit_log` vs `public.admin_audit_log`).
  {
    href: "/admin/pennpaps/orders",
    label: "PennPaps Orders",
    matchPrefix: "/admin/pennpaps/orders",
  },
  {
    href: "/admin/pennpaps/analytics",
    label: "PennPaps Analytics",
    matchPrefix: "/admin/pennpaps/analytics",
  },
  {
    href: "/admin/pennpaps/reminders",
    label: "PennPaps Reminders",
    matchPrefix: "/admin/pennpaps/reminders",
  },
  {
    href: "/admin/pennpaps/audit",
    label: "PennPaps Audit",
    matchPrefix: "/admin/pennpaps/audit",
  },
];

function NavItem({
  href,
  label,
  isActive,
}: {
  href: string;
  label: string;
  isActive: boolean;
}) {
  // The nav-item-active / nav-item-idle utilities live in index.css —
  // active state is navy fill + gold leading accent, idle hovers to a
  // surface-3 wash with a faint gold leading hint, which gives the
  // sidebar a more refined sense of focus than the old static border.
  return (
    <Link
      href={href}
      className={`block px-4 py-2 text-sm rounded-md font-medium ${
        isActive ? "nav-item-active" : "nav-item-idle"
      }`}
      aria-current={isActive ? "page" : undefined}
    >
      {label}
    </Link>
  );
}

function isLinkActive(location: string, link: (typeof NAV_LINKS)[number]): boolean {
  if (link.href === "/admin")
    return location === "/admin" || location === "/admin/";
  const prefix = link.matchPrefix ?? link.href;
  return location === prefix || location.startsWith(`${prefix}/`);
}

export function AdminHeaderChip({
  email,
  role,
}: {
  email: string;
  role: AdminRole;
}) {
  const { signOut } = useDashboardIdentity();
  const [, setShellLocation] = useLocation();
  // The role badge uses different chrome colours for the two roles
  // so an operator can tell at a glance whether they're signed in
  // as a full admin (navy) or a customer-service agent (gold). We
  // intentionally make the agent badge MORE visible (gold-on-navy
  // border + bold text) so the privilege downgrade is obvious —
  // an agent who misses the signal might assume a hidden Delete
  // button is a bug rather than a permission boundary.
  const isAdmin = role === "admin";
  const badgeStyle = isAdmin
    ? {
        backgroundColor: "hsl(var(--penn-navy-deep))",
        color: "#ffffff",
        border: "1px solid hsl(var(--penn-gold) / 0.6)",
        boxShadow: "0 0 0 2px hsl(var(--penn-gold) / 0.15)",
      }
    : {
        background:
          "linear-gradient(135deg, hsl(var(--penn-gold) / 0.30), hsl(var(--penn-gold) / 0.10))",
        color: "hsl(var(--penn-navy-deep))",
        border: "1px solid hsl(var(--penn-gold))",
      };
  return (
    <div className="flex items-center gap-3">
      <span>
        Signed in as <span className="font-semibold">{email}</span>
      </span>
      <span
        className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
        style={badgeStyle}
        title={
          isAdmin
            ? "Full admin — all operations available"
            : "Customer-service agent — destructive deletes are disabled"
        }
        data-testid="admin-role-badge"
      >
        {isAdmin ? "Admin" : "Agent"}
      </span>
      <button
        type="button"
        onClick={() => {
          // Drop any half-typed reply drafts before sign-out so PHI
          // doesn't survive across admin sessions on a shared
          // workstation. Must happen BEFORE signOut: once the auth provider
          // navigates away we lose the chance to run cleanup.
          clearAllDrafts();
          // Sign out via the identity shim, then navigate to
          // /sign-in. Soft-navigate via wouter so jsdom doesn't
          // refuse the navigation in tests; the cookie + cache
          // cleanup happens inside the identity shim's signOut().
          void signOut().finally(() => {
            setShellLocation("/admin/sign-in");
          });
        }}
        className="text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors"
        style={{
          color: "hsl(var(--penn-navy-deep))",
          backgroundColor: "#ffffff",
          borderColor: "hsl(var(--penn-gold))",
        }}
      >
        Sign out
      </button>
    </div>
  );
}

export function AppShell({
  adminEmail,
  adminRole = "admin",
  children,
}: {
  adminEmail?: string;
  adminRole?: AdminRole;
  children: ReactNode;
}) {
  const [location] = useLocation();

  return (
    <RoleProvider role={adminRole}>
    <div className="admin-root min-h-screen flex flex-col">
      <BrandHeader
        rightSlot={
          adminEmail ? (
            <div className="flex items-center gap-3">
              <GlobalLookup />
              <AdminHeaderChip email={adminEmail} role={adminRole} />
            </div>
          ) : undefined
        }
      />
      <div className="flex-1 flex">
        <aside className="sidebar-surface w-60 shrink-0 p-3 flex flex-col gap-1">
          <p
            className="text-[10px] uppercase tracking-[0.22em] font-semibold mb-2 px-2 mt-2"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            Navigation
          </p>
          {NAV_LINKS.map((link) => (
            <NavItem
              key={link.href}
              href={link.href}
              label={link.label}
              isActive={isLinkActive(location, link)}
            />
          ))}
        </aside>
        <main className="flex-1 p-6 overflow-x-hidden">{children}</main>
      </div>
      <BrandFooter />
    </div>
    </RoleProvider>
  );
}

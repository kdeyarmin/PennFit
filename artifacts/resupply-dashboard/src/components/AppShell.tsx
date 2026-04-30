import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useClerk } from "@clerk/react";
import { BrandHeader, BrandFooter } from "./BrandHeader";
import { ConsoleSwitcher } from "./ConsoleSwitcher";
import { RoleProvider, type AdminRole } from "../lib/role-context";
import { clearAllDrafts } from "../lib/use-draft-autosave";

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
  { href: "/", label: "Dashboard", matchPrefix: "/" },
  { href: "/patients", label: "Patients", matchPrefix: "/patients" },
  {
    href: "/conversations",
    label: "Conversations",
    matchPrefix: "/conversations",
  },
  { href: "/episodes", label: "Episodes", matchPrefix: "/episodes" },
  { href: "/rules", label: "Rules", matchPrefix: "/rules" },
  { href: "/audit", label: "Audit", matchPrefix: "/audit" },
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
    href: "/admin/shop/returns",
    label: "Returns & RMAs",
    matchPrefix: "/admin/shop/returns",
  },
];

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function NavItem({
  href,
  label,
  isActive,
}: {
  href: string;
  label: string;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      className="block px-4 py-2 text-sm rounded font-medium transition-colors"
      style={
        isActive
          ? {
              backgroundColor: "#0a1f44",
              color: "#ffffff",
              borderLeft: "3px solid #c9a24a",
            }
          : {
              color: "#0a1f44",
              borderLeft: "3px solid transparent",
            }
      }
      aria-current={isActive ? "page" : undefined}
    >
      {label}
    </Link>
  );
}

function isLinkActive(location: string, link: (typeof NAV_LINKS)[number]): boolean {
  if (link.href === "/") return location === "/" || location === "";
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
  const { signOut } = useClerk();
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
        backgroundColor: "#0a1f44",
        color: "#ffffff",
        border: "1px solid #0a1f44",
      }
    : {
        backgroundColor: "#fff7e0",
        color: "#0a1f44",
        border: "1px solid #c9a24a",
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
          // workstation. Must happen BEFORE signOut: once Clerk
          // navigates away we lose the chance to run cleanup.
          clearAllDrafts();
          void signOut({ redirectUrl: `${basePath}/sign-in` });
        }}
        className="text-xs font-semibold px-3 py-1.5 rounded border"
        style={{
          color: "#0a1f44",
          backgroundColor: "#ffffff",
          borderColor: "#c9a24a",
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
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <BrandHeader
        rightSlot={
          adminEmail ? (
            <AdminHeaderChip email={adminEmail} role={adminRole} />
          ) : undefined
        }
      />
      <div className="flex-1 flex">
        <aside
          className="w-56 shrink-0 border-r p-3 flex flex-col gap-1"
          style={{ backgroundColor: "#ffffff", borderColor: "#e5e7eb" }}
        >
          <ConsoleSwitcher />
          <p
            className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-2 px-2 mt-1"
            style={{ color: "#c9a24a" }}
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

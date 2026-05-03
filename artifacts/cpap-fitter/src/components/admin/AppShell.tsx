import type { ComponentType, ReactNode, SVGProps } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  MessageSquareText,
  ListChecks,
  Sparkles,
  Users,
  ShoppingBag,
  Repeat,
  Undo2,
  ShoppingCart,
  PackageCheck,
  HeartHandshake,
  Star,
  Boxes,
  TruckIcon,
  Activity,
  BarChart3,
  BellRing,
  ScrollText,
  ShieldCheck,
  FlaskConical,
  UsersRound,
  Settings,
  FileSearch,
} from "lucide-react";
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

type NavLink = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  matchPrefix?: string;
  /** Optional one-line hint shown as a `title` for new reps. */
  hint?: string;
};

type NavGroup = {
  label: string;
  items: ReadonlyArray<NavLink>;
};

/*
 * Sidebar navigation, grouped by job function instead of one flat
 * 28-item list. The previous shell rendered every page in a single
 * unbroken column, which made it slow for customer-service reps to
 * find anything — they had to read every label end-to-end. This
 * grouping mirrors how a rep's day actually flows:
 *
 *   1. INBOX        — the queues a rep lives in (chat, episodes, board)
 *   2. CUSTOMERS    — patient lookup + records
 *   3. ORDERS & SHOP — anything order-, return-, or product-related
 *   4. INSIGHTS     — operational health, reports, reminders
 *   5. SYSTEM       — admin-only configuration and audit trails
 *
 * Each item has an icon so reps can scan visually rather than read
 * every word, and an optional `hint` shown via the link's title for
 * new hires who don't yet know what each section does.
 */
const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Inbox",
    items: [
      {
        href: "/admin",
        label: "Dashboard",
        icon: LayoutDashboard,
        matchPrefix: "/admin",
        hint: "Today's queues and team workload at a glance",
      },
      {
        href: "/admin/conversations",
        label: "Conversations",
        icon: MessageSquareText,
        matchPrefix: "/admin/conversations",
        hint: "Inbound SMS, MMS, and email threads",
      },
      {
        href: "/admin/episodes",
        label: "Episodes",
        icon: ListChecks,
        matchPrefix: "/admin/episodes",
        hint: "Open service episodes that need follow-up",
      },
      {
        href: "/admin/macros",
        label: "Canned Replies",
        icon: Sparkles,
        matchPrefix: "/admin/macros",
        hint: "Reusable response templates",
      },
    ],
  },
  {
    label: "Customers",
    items: [
      {
        href: "/admin/patients",
        label: "Patients",
        icon: Users,
        matchPrefix: "/admin/patients",
        hint: "Patient roster, profiles, and 360 view",
      },
    ],
  },
  {
    label: "Orders & Shop",
    items: [
      {
        href: "/admin/pennpaps/orders",
        label: "Orders",
        icon: ShoppingBag,
        matchPrefix: "/admin/pennpaps/orders",
        hint: "Storefront orders — fulfill, refund, look up",
      },
      {
        href: "/admin/shop/subscriptions",
        label: "Subscriptions",
        icon: Repeat,
        matchPrefix: "/admin/shop/subscriptions",
        hint: "Recurring resupply plans and health",
      },
      {
        href: "/admin/shop/returns",
        label: "Returns & RMAs",
        icon: Undo2,
        matchPrefix: "/admin/shop/returns",
        hint: "Return requests, restocks, refund decisions",
      },
      {
        href: "/admin/shop/abandoned-carts",
        label: "Abandoned Carts",
        icon: ShoppingCart,
        matchPrefix: "/admin/shop/abandoned-carts",
        hint: "Carts to recover via outreach",
      },
      {
        href: "/admin/shop/back-in-stock",
        label: "Back-in-Stock",
        icon: PackageCheck,
        matchPrefix: "/admin/shop/back-in-stock",
        hint: "Customers waiting on restocked items",
      },
      {
        href: "/admin/shop/insurance-leads",
        label: "Insurance Leads",
        icon: HeartHandshake,
        matchPrefix: "/admin/shop/insurance-leads",
        hint: "New benefit-verification requests",
      },
      {
        href: "/admin/shop/reviews",
        label: "Reviews",
        icon: Star,
        matchPrefix: "/admin/shop/reviews",
        hint: "Customer product reviews — moderate & reply",
      },
      {
        href: "/admin/shop/inventory",
        label: "Inventory",
        icon: Boxes,
        matchPrefix: "/admin/shop/inventory",
        hint: "Catalog, stock levels, product editor",
      },
    ],
  },
  {
    label: "Insights",
    items: [
      {
        href: "/admin/operations",
        label: "Operations",
        icon: Activity,
        matchPrefix: "/admin/operations",
        hint: "Health of background jobs and pipelines",
      },
      {
        href: "/admin/delivery-failures",
        label: "Delivery Failures",
        icon: TruckIcon,
        matchPrefix: "/admin/delivery-failures",
        hint: "Bounced messages and shipping exceptions",
      },
      {
        href: "/admin/reports",
        label: "Reports",
        icon: BarChart3,
        matchPrefix: "/admin/reports",
        hint: "Operational KPIs and exports",
      },
      {
        href: "/admin/pennpaps/analytics",
        label: "Storefront Analytics",
        icon: BarChart3,
        matchPrefix: "/admin/pennpaps/analytics",
        hint: "PennPaps storefront traffic & revenue",
      },
      {
        href: "/admin/pennpaps/reminders",
        label: "Reminders",
        icon: BellRing,
        matchPrefix: "/admin/pennpaps/reminders",
        hint: "Scheduled patient resupply reminders",
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        href: "/admin/rules",
        label: "Rules",
        icon: ScrollText,
        matchPrefix: "/admin/rules",
        hint: "Automation rules that trigger replies & actions",
      },
      {
        href: "/admin/rule-tester",
        label: "Rule Tester",
        icon: FlaskConical,
        matchPrefix: "/admin/rule-tester",
        hint: "Dry-run a rule against sample input",
      },
      {
        href: "/admin/audit",
        label: "Audit Log",
        icon: ShieldCheck,
        matchPrefix: "/admin/audit",
        hint: "Resupply admin activity trail",
      },
      {
        href: "/admin/pennpaps/audit",
        label: "Storefront Audit",
        icon: FileSearch,
        matchPrefix: "/admin/pennpaps/audit",
        hint: "PennPaps storefront audit trail",
      },
      {
        href: "/admin/team",
        label: "Team",
        icon: UsersRound,
        matchPrefix: "/admin/team",
        hint: "Manage admin & agent accounts",
      },
      {
        href: "/admin/settings",
        label: "Settings",
        icon: Settings,
        matchPrefix: "/admin/settings",
        hint: "Practice settings & integrations",
      },
    ],
  },
];

function NavItem({
  href,
  label,
  icon: Icon,
  hint,
  isActive,
}: NavLink & { isActive: boolean }) {
  // The nav-item-active / nav-item-idle utilities live in admin.css —
  // active state is navy fill + gold leading accent, idle hovers to a
  // surface-3 wash with a faint gold leading hint. We add a leading
  // icon so reps can scan the sidebar visually rather than reading
  // every label.
  return (
    <Link
      href={href}
      title={hint}
      className={`flex items-center gap-2.5 px-3 py-2 text-sm rounded-md font-medium ${
        isActive ? "nav-item-active" : "nav-item-idle"
      }`}
      aria-current={isActive ? "page" : undefined}
      data-testid={`admin-nav-${href.replace(/\//g, "-").replace(/^-/, "")}`}
    >
      <Icon
        className="h-4 w-4 shrink-0 opacity-90"
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function isLinkActive(location: string, link: NavLink): boolean {
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
        {/*
          Grouped sidebar navigation. Each section gets a small
          gold uppercase header so reps can locate the right family
          of pages at a glance rather than scanning a flat list of
          ~28 items. Sticky inside its own scroll context so the
          nav stays visible on long detail pages, with its own
          inner scroll if a particularly small viewport can't fit
          every group at once.
        */}
        <aside
          className="sidebar-surface w-64 shrink-0 flex flex-col"
          aria-label="Admin navigation"
        >
          <nav
            className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-5 sticky top-0"
            style={{ maxHeight: "calc(100vh - 4rem)" }}
          >
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                <p
                  className="text-[10px] uppercase tracking-[0.22em] font-semibold mb-1.5 px-3"
                  style={{ color: "hsl(var(--penn-gold-deep))" }}
                >
                  {group.label}
                </p>
                {group.items.map((link) => (
                  <NavItem
                    key={link.href}
                    {...link}
                    isActive={isLinkActive(location, link)}
                  />
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="flex-1 p-6 overflow-x-hidden">{children}</main>
      </div>
      <BrandFooter />
    </div>
    </RoleProvider>
  );
}

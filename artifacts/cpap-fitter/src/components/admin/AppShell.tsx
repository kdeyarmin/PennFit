import {
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  fetchAdminInboxCounts,
  type AdminInboxCounts,
} from "@/lib/admin/inbox-counts-api";
import {
  LayoutDashboard,
  Inbox,
  MessageSquareText,
  ListChecks,
  CalendarClock,
  Sparkles,
  Mail,
  Users,
  ShoppingBag,
  Repeat,
  Undo2,
  ShoppingCart,
  PackageCheck,
  HeartHandshake,
  HeartPulse,
  Star,
  HelpCircle,
  Boxes,
  AlertOctagon,
  CalendarOff,
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
  Menu,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useDashboardIdentity } from "@/lib/admin/identity";
import { getMfaStatus } from "@/lib/admin/mfa-api";
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
  /**
   * Phase 16 — actionable-work badge. When set, picks the count from
   * the inbox-counts query and shows it as a pill next to the label.
   * "0" suppresses rendering so we don't show empty badges everywhere.
   */
  badgeKey?:
    | "awaitingReplyConversations"
    | "pendingReturns"
    | "pendingReviews"
    | "overdueFollowups"
    | "newPatientDocuments"
    | "newInboundFaxes";
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
        href: "/admin/today",
        label: "My Today",
        icon: Inbox,
        matchPrefix: "/admin/today",
        hint: "Top items across every queue — conversations, returns, alerts, Rx renewals, documents",
      },
      {
        href: "/admin/conversations",
        label: "Conversations",
        icon: MessageSquareText,
        matchPrefix: "/admin/conversations",
        hint: "Inbound SMS, MMS, and email threads",
        badgeKey: "awaitingReplyConversations",
      },
      {
        href: "/admin/episodes",
        label: "Episodes",
        icon: ListChecks,
        matchPrefix: "/admin/episodes",
        hint: "Open service episodes that need follow-up",
      },
      {
        href: "/admin/followups",
        label: "Follow-ups",
        icon: CalendarClock,
        matchPrefix: "/admin/followups",
        hint: "Today's queue of CSR-scheduled callbacks across customers and patients",
        badgeKey: "overdueFollowups",
      },
      {
        href: "/admin/macros",
        label: "Canned Replies",
        icon: Sparkles,
        matchPrefix: "/admin/macros",
        hint: "Reusable response templates",
      },
      {
        href: "/admin/templates",
        label: "Message Templates",
        icon: Mail,
        matchPrefix: "/admin/templates",
        hint: "Edit the copy used by automated customer messages",
      },
      {
        href: "/admin/bulk-campaigns",
        label: "Bulk Campaigns",
        icon: BellRing,
        matchPrefix: "/admin/bulk-campaigns",
        hint: "Resolve audience + draft a bulk email send",
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
        badgeKey: "newPatientDocuments",
      },
      {
        href: "/admin/providers",
        label: "Providers",
        icon: HeartHandshake,
        matchPrefix: "/admin/providers",
        hint: "Central physician/NP registry — NPPES-backed",
      },
      {
        href: "/admin/inbound-faxes",
        label: "Inbound faxes",
        icon: Inbox,
        matchPrefix: "/admin/inbound-faxes",
        hint: "Triage queue for faxes Twilio delivered — sleep studies, Rx renewals, chart notes",
        badgeKey: "newInboundFaxes",
      },
      {
        href: "/admin/equipment-recalls",
        label: "Recalls",
        icon: ShieldCheck,
        matchPrefix: "/admin/equipment-recalls",
        hint: "Manufacturer recall registry + scan against dispensed serials",
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
        badgeKey: "pendingReturns",
      },
      {
        href: "/admin/shop/backorders",
        label: "Backorders & subs",
        icon: AlertOctagon,
        matchPrefix: "/admin/shop/backorders",
        hint: "Mark SKUs out of stock; manage resupply substitution rules",
      },
      {
        href: "/admin/shop/customers",
        label: "Customers",
        icon: UsersRound,
        matchPrefix: "/admin/shop/customers",
        hint: "Registered shop accounts, with clinical info + in-app messaging",
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
        badgeKey: "pendingReviews",
      },
      {
        href: "/admin/shop/product-questions",
        label: "Product Q&A",
        icon: HelpCircle,
        matchPrefix: "/admin/shop/product-questions",
        hint: "Customer-submitted questions — answer or reject",
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
        href: "/admin/productivity",
        label: "Team throughput",
        icon: Activity,
        matchPrefix: "/admin/productivity",
        hint: "Per-agent close / approve / resolve counts",
      },
      {
        href: "/admin/rt-overview",
        label: "RT Overview",
        icon: HeartPulse,
        matchPrefix: "/admin/rt-overview",
        hint: "At-a-glance therapy board: alerts, AHI, leak, usage",
      },
      {
        href: "/admin/analytics",
        label: "Clinical Analytics",
        icon: Activity,
        matchPrefix: "/admin/analytics",
        hint: "Resupply funnel, compliance cohorts, CSR productivity",
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
        href: "/admin/compliance",
        label: "Compliance binder",
        icon: ShieldCheck,
        matchPrefix: "/admin/compliance",
        hint: "Staff training records + patient grievances for DMEPOS surveyors",
      },
      {
        href: "/admin/coaching",
        label: "Adherence coaching",
        icon: HeartPulse,
        matchPrefix: "/admin/coaching",
        hint: "Outreach plans for patients with slipping CPAP adherence",
      },
      {
        href: "/admin/security",
        label: "Account security",
        icon: ShieldCheck,
        matchPrefix: "/admin/security",
        hint: "Manage your own MFA / authenticator-app enrollment",
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
        href: "/admin/closures",
        label: "Closures",
        icon: CalendarOff,
        matchPrefix: "/admin/closures",
        hint: "Holidays and weather closures with inbound-SMS auto-reply",
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
  badgeCount,
}: NavLink & { isActive: boolean; badgeCount?: number }) {
  // The nav-item-active / nav-item-idle utilities live in admin.css —
  // active state is navy fill + gold leading accent, idle hovers to a
  // surface-3 wash with a faint gold leading hint. We add a leading
  // icon so reps can scan the sidebar visually rather than reading
  // every label.
  const showBadge = typeof badgeCount === "number" && badgeCount > 0;
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
      <Icon className="h-4 w-4 shrink-0 opacity-90" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {showBadge && (
        <span
          className="ml-auto inline-flex items-center justify-center rounded-full bg-rose-600 px-2 text-[10px] font-bold leading-5 text-white min-w-[1.25rem]"
          aria-label={`${badgeCount} pending`}
          data-testid={`admin-nav-badge-${href.replace(/\//g, "-").replace(/^-/, "")}`}
        >
          {badgeCount > 99 ? "99+" : badgeCount}
        </span>
      )}
    </Link>
  );
}

function isLinkActive(location: string, link: NavLink): boolean {
  if (link.href === "/admin")
    return location === "/admin" || location === "/admin/";
  const prefix = link.matchPrefix ?? link.href;
  return location === prefix || location.startsWith(`${prefix}/`);
}

/**
 * The grouped nav body. Used by both the persistent desktop sidebar
 * and the mobile slide-out drawer so they stay 1:1 in sync — adding
 * a new section to NAV_GROUPS automatically lands in both surfaces.
 */
function SidebarNavBody({
  location,
  onItemClick,
  isAdminConfirmed,
}: {
  location: string;
  onItemClick?: () => void;
  /** True once /admin/me has confirmed the session is valid admin.
   *  Keeps the inbox-counts query from firing with a 401 during the
   *  initial access-check state before adminEmail is populated. */
  isAdminConfirmed: boolean;
}) {
  // Phase 16 — actionable-work counts powering nav badges. Cached for
  // 30s so paging through the SPA doesn't hammer the endpoint, but
  // refetched on window focus so a CSR who clears the inbox in another
  // tab sees the badge drop without reloading. Failures degrade
  // silently — badges just don't render rather than blocking the nav.
  // Gated on `isAdminConfirmed` so we don't fire a request that will
  // 401 before the session check completes.
  const { data: counts } = useQuery({
    queryKey: ["admin-inbox-counts"],
    queryFn: fetchAdminInboxCounts,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
    enabled: isAdminConfirmed,
  });
  return (
    <div className="flex flex-col gap-5">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p
            className="text-[10px] uppercase tracking-[0.22em] font-semibold mb-1.5 px-3"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            {group.label}
          </p>
          {group.items.map((link) => (
            <div key={link.href} onClick={onItemClick}>
              <NavItem
                {...link}
                isActive={isLinkActive(location, link)}
                badgeCount={badgeCountFor(link, counts)}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function badgeCountFor(
  link: NavLink,
  counts: AdminInboxCounts | undefined,
): number {
  if (!link.badgeKey || !counts) return 0;
  return counts[link.badgeKey] ?? 0;
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

/**
 * Sticky banner shown on every admin page when the org has flipped
 * AUTH_REQUIRE_MFA_FOR_ADMINS=true AND this caller hasn't enrolled.
 * We don't hard-redirect — the caller may legitimately be on
 * /admin/security already, and a forced redirect mid-form would be
 * jarring — but we surface the requirement visibly on every screen.
 * Surveyors looking at the live admin UI see the enforcement and
 * the path to compliance.
 */
function MfaEnforcementBanner() {
  const [location] = useLocation();
  const { data } = useQuery({
    queryKey: ["admin", "mfa", "status"] as const,
    queryFn: getMfaStatus,
    // Cheap; refetching on focus keeps the banner accurate when an
    // admin enrolls in another tab.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  if (!data?.mustEnroll) return null;
  if (location === "/admin/security") {
    // Caller is already where they need to be — render a calmer
    // inline notice rather than a redirect.
    return (
      <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        Enroll multi-factor authentication below to access the rest of
        the admin console. This is a policy-level requirement; your team
        flipped it on.
      </div>
    );
  }
  return (
    <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 flex items-start justify-between gap-3">
      <div>
        <strong>Multi-factor authentication is required.</strong> You
        must enroll an authenticator app before you can keep using the
        admin console. This policy applies to every admin / CSR
        account.
      </div>
      <Link
        href="/admin/security"
        className="rounded bg-amber-900 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
      >
        Enroll now
      </Link>
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Auto-close the mobile drawer on every route change so reps don't
  // have to tap the X after picking a destination.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

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
        {/*
        Mobile-only sub-bar: hamburger trigger that opens the same
        grouped nav inside a left-anchored Sheet drawer. Hidden at
        lg+ where the persistent sidebar takes over. We render this
        in its own row (instead of squeezing into BrandHeader) so the
        existing header chrome stays untouched and the trigger has
        room to be a comfortable 44px tap target.
      */}
        {adminEmail ? (
          <div className="lg:hidden border-b border-border/60 bg-white px-4 py-2 flex items-center gap-2">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 px-3 h-10 rounded-md border border-border bg-white text-sm font-semibold text-[hsl(var(--penn-navy))] hover:bg-secondary/60"
                  aria-label="Open admin navigation"
                  data-testid="admin-mobile-nav-trigger"
                >
                  <Menu className="h-4 w-4" aria-hidden="true" />
                  Menu
                </button>
              </SheetTrigger>
              <SheetContent
                side="left"
                /*
                Radix portals SheetContent to <body>, OUTSIDE the
                <div className="admin-root"> wrapper, so the admin
                CSS variables (--surface-2, --penn-navy, etc) don't
                resolve here and the sidebar-surface gradient renders
                transparent — the dashboard content shows through
                behind the nav items. Re-applying `admin-root` on the
                portal scopes those tokens locally so the drawer
                renders opaque with the correct admin chrome.
              */
                className="admin-root w-72 p-0 sidebar-surface flex flex-col bg-white"
              >
                <SheetHeader className="px-4 py-3 border-b border-border/60">
                  <SheetTitle className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
                    Admin navigation
                  </SheetTitle>
                </SheetHeader>
                <nav
                  className="flex-1 overflow-y-auto px-3 py-4"
                  aria-label="Admin navigation"
                >
                  <SidebarNavBody
                    location={location}
                    onItemClick={() => setMobileNavOpen(false)}
                    isAdminConfirmed={!!adminEmail}
                  />
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        ) : null}
        <div className="flex-1 flex">
          {/*
          Persistent grouped sidebar — desktop only. Each section
          gets a small gold uppercase header so reps can locate the
          right family of pages at a glance rather than scanning a
          flat list of ~28 items. Sticky inside its own scroll
          context so the nav stays visible on long detail pages,
          with its own inner scroll if a particularly small laptop
          viewport can't fit every group at once. On <lg viewports
          the sidebar is hidden in favour of the slide-out drawer
          above so the main content can claim the full width.
        */}
          <aside
            className="sidebar-surface w-64 shrink-0 hidden lg:flex flex-col"
            aria-label="Admin navigation"
          >
            <nav
              className="flex-1 overflow-y-auto px-3 py-4 sticky top-0"
              style={{ maxHeight: "calc(100vh - 4rem)" }}
            >
              <SidebarNavBody location={location} isAdminConfirmed={!!adminEmail} />
            </nav>
          </aside>
          <main className="flex-1 p-4 sm:p-6 overflow-x-hidden min-w-0">
            <MfaEnforcementBanner />
            {children}
          </main>
        </div>
        <BrandFooter />
      </div>
    </RoleProvider>
  );
}

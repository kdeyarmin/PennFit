import {
  useEffect,
  useMemo,
  useRef,
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
  CalendarPlus,
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
  Plug,
  Webhook,
  Target,
  Menu,
  CircleDollarSign,
  Landmark,
  Gavel,
  FilePlus2,
  Wallet,
  Bot,
  ListFilter,
  TrendingDown,
  TrendingUp,
  ClipboardCheck,
  ShieldAlert,
  SlidersHorizontal,
  CalendarRange,
  ToggleLeft,
  ChevronRight,
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
  /**
   * Granular RBAC permission key required to USE the destination page
   * (e.g. `admin.tools.manage`). When set, the nav entry is hidden for
   * callers whose `/admin/me` permission set doesn't include it — so a
   * CSR never sees a link that would 403. Purely a UX guardrail; the
   * server-side `requirePermission(...)` is the real boundary.
   */
  requiredPermission?: string;
};

type NavGroup = {
  label: string;
  items: ReadonlyArray<NavLink>;
};

/*
 * Sidebar navigation, grouped by job function. Groups are
 * COLLAPSIBLE — see SidebarNavBody. Default: only the group
 * containing the current route is open; the user's per-group
 * expand/collapse state is persisted to localStorage so the
 * sidebar comes back the way they left it.
 *
 *   1. INBOX        — the queues a rep lives in (chat, episodes, board)
 *   2. CUSTOMERS    — patient lookup + records
 *   3. ORDERS & SHOP — anything order-, return-, or product-related
 *   4. BILLING      — claims, denials, eligibility, AR
 *   5. INSIGHTS     — operational health, reports, reminders
 *   6. SYSTEM       — admin-only configuration and audit trails
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
        href: "/admin/work-queue",
        label: "Work queue",
        icon: ListChecks,
        matchPrefix: "/admin/work-queue",
        hint: "Unified, prioritized queue of everything waiting on you, most-overdue first",
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
        href: "/admin/appointment-requests",
        label: "Appointment requests",
        icon: CalendarPlus,
        matchPrefix: "/admin/appointment-requests",
        hint: "CSR queue for patient-initiated appointment requests",
      },
      {
        href: "/admin/macros",
        label: "Canned Replies",
        icon: Sparkles,
        matchPrefix: "/admin/macros",
        hint: "Reusable response templates",
        requiredPermission: "admin.tools.manage",
      },
      {
        href: "/admin/templates",
        label: "Message Templates",
        icon: Mail,
        matchPrefix: "/admin/templates",
        hint: "Edit the copy used by automated customer messages",
        requiredPermission: "admin.tools.manage",
      },
      {
        href: "/admin/bulk-campaigns",
        label: "Bulk Campaigns",
        icon: BellRing,
        matchPrefix: "/admin/bulk-campaigns",
        hint: "Resolve audience + draft a bulk email send",
      },
      {
        href: "/admin/alerts",
        label: "Alert Library",
        icon: AlertOctagon,
        matchPrefix: "/admin/alerts",
        hint: "Send curated email / SMS / phone-call alerts to a patient",
        requiredPermission: "admin.tools.manage",
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
        href: "/admin/clinical",
        label: "Clinical encounters",
        icon: HeartPulse,
        matchPrefix: "/admin/clinical",
        hint: "Document + review patient clinical encounters (RT)",
        requiredPermission: "clinical.read",
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
        hint: "Triage queue for inbound faxes — sleep studies, Rx renewals, chart notes",
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
        href: "/admin/fitter-leads",
        label: "Fitter Prospects",
        icon: UsersRound,
        matchPrefix: "/admin/fitter-leads",
        hint: "Fitter funnel + supply-campaign conversion",
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
      {
        href: "/admin/shop/inventory/reconcile",
        label: "Reconcile",
        icon: ClipboardCheck,
        matchPrefix: "/admin/shop/inventory/reconcile",
        hint: "Monthly physical count & variance report",
      },
    ],
  },
  {
    label: "Billing",
    items: [
      {
        href: "/admin/billing",
        label: "Billing Hub",
        icon: CircleDollarSign,
        matchPrefix: "/admin/billing",
        hint: "AR director dashboard — KPIs, money in flight, top payers",
      },
      {
        href: "/admin/billing/ai-queue",
        label: "AI queue",
        icon: Bot,
        matchPrefix: "/admin/billing/ai-queue",
        hint: "Scrubber-blocked + denial-analyzer worklist with auto-resubmit",
      },
      {
        href: "/admin/billing/eligibility",
        label: "Eligibility",
        icon: ClipboardCheck,
        matchPrefix: "/admin/billing/eligibility",
        hint: "System-wide 270/271 worklist — rejected and inactive coverage rise to the top",
      },
      {
        href: "/admin/billing/eligibility-recheck",
        label: "Re-verification",
        icon: ShieldCheck,
        matchPrefix: "/admin/billing/eligibility-recheck",
        hint: "Active coverages due for re-verification — never-checked, terminating soon, or stale",
        requiredPermission: "reports.read",
      },
      {
        href: "/admin/billing/prior-auths",
        label: "Prior auths",
        icon: ShieldAlert,
        matchPrefix: "/admin/billing/prior-auths",
        hint: "Missed / at-risk SLA + auths expiring soon + drafts to submit",
      },
      {
        href: "/admin/billing/aging",
        label: "A/R aging",
        icon: ListFilter,
        matchPrefix: "/admin/billing/aging",
        hint: "Open claims by 0/30/60/90 day bucket and by payer",
      },
      {
        href: "/admin/billing/timely-filing",
        label: "Filing deadlines",
        icon: CalendarClock,
        matchPrefix: "/admin/billing/timely-filing",
        hint: "Open claims ranked by days left before the payer's timely-filing window closes",
      },
      {
        href: "/admin/billing/payer-profitability",
        label: "Payer profitability",
        icon: Landmark,
        matchPrefix: "/admin/billing/payer-profitability",
        hint: "Net yield by payer: billed → allowed → collected, denial rate, net of cost",
        requiredPermission: "cost.read",
      },
      {
        href: "/admin/billing/denials",
        label: "Denials & DSO",
        icon: TrendingDown,
        matchPrefix: "/admin/billing/denials",
        hint: "90-day denial rate + 180-day days-to-pay, per payer",
      },
      {
        href: "/admin/billing/denials-worklist",
        label: "Denials worklist",
        icon: Gavel,
        matchPrefix: "/admin/billing/denials-worklist",
        hint: "Open denials ranked by recoverable $ × win-probability",
        requiredPermission: "reports.read",
      },
      {
        href: "/admin/billing/era",
        label: "ERA files",
        icon: Wallet,
        matchPrefix: "/admin/billing/era",
        hint: "Upload an 835 to auto-post payer adjudications",
      },
      {
        href: "/admin/billing/capped-rentals",
        label: "Capped rentals",
        icon: CalendarRange,
        matchPrefix: "/admin/billing/capped-rentals",
        hint: "13- and 36-month CMS rental cycle tracker + KH/KI/KX modifier rotation",
      },
      {
        href: "/admin/billing/manual-claim",
        label: "Manual claim",
        icon: FilePlus2,
        matchPrefix: "/admin/billing/manual-claim",
        hint: "Key a corrected / void-replacement / paper-backup claim by hand",
        requiredPermission: "patients.update",
      },
      {
        href: "/admin/billing/config",
        label: "Config",
        icon: SlidersHorizontal,
        matchPrefix: "/admin/billing/config",
        hint: "Payer profiles, fee schedules, modifier rules, denial codes, claim templates",
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
        href: "/admin/integrations",
        label: "Integrations",
        icon: Plug,
        matchPrefix: "/admin/integrations",
        hint: "Therapy-cloud vendor connections and nightly sync status",
      },
      {
        href: "/admin/therapy-fleet",
        label: "Therapy Fleet",
        icon: HeartPulse,
        matchPrefix: "/admin/therapy-fleet",
        hint: "Population compliance cohorts and clinical outreach worklist",
      },
      {
        href: "/admin/therapy-resupply",
        label: "Resupply Opportunities",
        icon: PackageCheck,
        matchPrefix: "/admin/therapy-resupply",
        hint: "Device-reported supplies due for replacement — drives resupply orders",
      },
      {
        href: "/admin/therapy-compliance",
        label: "Setup Adherence",
        icon: ClipboardCheck,
        matchPrefix: "/admin/therapy-compliance",
        hint: "CMS 90-day adherence tracker for new Medicare setups",
      },
      {
        href: "/admin/delivery-failures",
        label: "Delivery Failures",
        icon: TruckIcon,
        matchPrefix: "/admin/delivery-failures",
        hint: "Bounced messages and shipping exceptions",
      },
      {
        href: "/admin/webhook-deliveries",
        label: "Webhook Deliveries",
        icon: Webhook,
        matchPrefix: "/admin/webhook-deliveries",
        hint: "Outbound event deliveries to partner endpoints — re-queue failed/exhausted sends",
        requiredPermission: "admin.tools.manage",
      },
      {
        href: "/admin/reports",
        label: "Reports",
        icon: BarChart3,
        matchPrefix: "/admin/reports",
        hint: "CSV, PDF, and QuickBooks (IIF / QBO) exports for ops and finance",
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
        href: "/admin/analytics/margin",
        label: "Margin & COGS",
        icon: CircleDollarSign,
        matchPrefix: "/admin/analytics/margin",
        hint: "Gross margin and % by product and overall, from captured cost",
        requiredPermission: "cost.read",
      },
      {
        href: "/admin/analytics/ltv-cac",
        label: "LTV & CAC",
        icon: TrendingUp,
        matchPrefix: "/admin/analytics/ltv-cac",
        hint: "Lifetime value vs acquisition cost by channel, with LTV:CAC",
        requiredPermission: "cost.read",
      },
      {
        href: "/admin/analytics/inventory-turnover",
        label: "Inventory turnover",
        icon: Boxes,
        matchPrefix: "/admin/analytics/inventory-turnover",
        hint: "Turnover (COGS ÷ inventory value) + stockout demand per SKU",
        requiredPermission: "cost.read",
      },
      {
        href: "/admin/goals",
        label: "Goals & targets",
        icon: Target,
        matchPrefix: "/admin/goals",
        hint: "Set KPI targets per period and track pace-to-goal vs. actuals",
        requiredPermission: "targets.manage",
      },
      {
        href: "/admin/kpi-alerts",
        label: "KPI alerts",
        icon: BellRing,
        matchPrefix: "/admin/kpi-alerts",
        hint: "KPI threshold alert feed + rule config (revenue, denials, churn)",
        requiredPermission: "metrics.read",
      },
      {
        href: "/admin/analytics",
        label: "Clinical Analytics",
        icon: Activity,
        matchPrefix: "/admin/analytics",
        hint: "Resupply funnel, compliance cohorts, CSR productivity",
      },
      {
        href: "/admin/therapy-usage-report",
        label: "Therapy Report",
        icon: ScrollText,
        matchPrefix: "/admin/therapy-usage-report",
        hint: "Provider-ready, print-quality therapy adherence snapshot (by provider, patient, or manufacturer)",
      },
      {
        href: "/admin/nps",
        label: "Customer NPS",
        icon: Star,
        matchPrefix: "/admin/nps",
        hint: "Post-delivery NPS responses with comment tail",
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
        href: "/admin/control-center",
        label: "Control Center",
        icon: ToggleLeft,
        matchPrefix: "/admin/control-center",
        hint: "On/off switches for major features (voice, SMS, campaigns, AI billing, …)",
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

function linkMatchPrefix(link: NavLink): string {
  return link.matchPrefix ?? link.href;
}

function linkMatchesLocation(location: string, link: NavLink): boolean {
  // The Dashboard ("/admin") item is exact-only — the bare /admin
  // route shouldn't claim every /admin/* subpath.
  if (link.href === "/admin") {
    return location === "/admin" || location === "/admin/";
  }
  const prefix = linkMatchPrefix(link);
  return location === prefix || location.startsWith(`${prefix}/`);
}

/**
 * Longest-prefix-wins active selection. When a parent ("Billing Hub"
 * @ /admin/billing) and a child ("AI queue" @ /admin/billing/ai-queue)
 * both match the current location, only the child should highlight.
 * We compute the winning href once per render and the per-link
 * checker compares to it instead of doing its own prefix match.
 */
function pickActiveHref(
  location: string,
  groups: ReadonlyArray<NavGroup>,
): string | null {
  let best: { href: string; specificity: number } | null = null;
  for (const g of groups) {
    for (const link of g.items) {
      if (!linkMatchesLocation(location, link)) continue;
      // Specificity = length of the prefix that matched; ties go to
      // the first one seen (NAV_GROUPS order).
      const specificity = linkMatchPrefix(link).length;
      if (!best || specificity > best.specificity) {
        best = { href: link.href, specificity };
      }
    }
  }
  return best?.href ?? null;
}

/**
 * Find which NAV_GROUPS section owns the currently-active link, so
 * that group can be auto-expanded for a rep who deep-links into a
 * collapsed section.
 */
function findGroupForActiveHref(
  groups: ReadonlyArray<NavGroup>,
  activeHref: string | null,
): string | null {
  if (!activeHref) return null;
  for (const g of groups) {
    if (g.items.some((it) => it.href === activeHref)) return g.label;
  }
  return null;
}

const NAV_EXPANDED_STORAGE_KEY = "pf-admin-nav-expanded-groups";
const NAV_EXPLICIT_COLLAPSED_STORAGE_KEY =
  "pf-admin-nav-explicit-collapsed-groups";

function loadInitialExpandedGroups(activeGroup: string | null): Set<string> {
  const fallback = new Set(activeGroup ? [activeGroup] : []);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(NAV_EXPANDED_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((s): s is string => typeof s === "string")
    ) {
      return new Set(parsed);
    }
  } catch {
    /* localStorage unavailable / corrupt — fall through */
  }
  return fallback;
}

function persistExpandedGroups(expanded: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      NAV_EXPANDED_STORAGE_KEY,
      JSON.stringify(Array.from(expanded)),
    );
  } catch {
    /* quota / private-mode — non-fatal */
  }
}

function loadExplicitCollapsedGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(NAV_EXPLICIT_COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((s): s is string => typeof s === "string")
    ) {
      return new Set(parsed);
    }
  } catch {
    /* localStorage unavailable / corrupt — fall through */
  }
  return new Set();
}

function persistExplicitCollapsedGroups(explicitCollapsed: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      NAV_EXPLICIT_COLLAPSED_STORAGE_KEY,
      JSON.stringify(Array.from(explicitCollapsed)),
    );
  } catch {
    /* quota / private-mode — non-fatal */
  }
}

function groupDomId(label: string): string {
  return `admin-nav-section-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * The grouped nav body. Used by both the persistent desktop sidebar
 * and the mobile slide-out drawer so they stay 1:1 in sync — adding
 * a new section to NAV_GROUPS automatically lands in both surfaces.
 *
 * Groups are collapsible. By default the group containing the
 * current route is open; the user's manual toggles are persisted
 * to localStorage so the sidebar comes back the way they left it.
 * When a group is collapsed, any badge counts on its items roll up
 * into a single pill on the group header so reps still see pending
 * work without expanding every section.
 *
 * `expanded` and `onToggleGroup` are lifted to the parent AppShell so
 * the desktop sidebar and the mobile drawer share a single state and
 * never race each other writing to localStorage.
 */
function SidebarNavBody({
  location,
  expanded,
  onToggleGroup,
  onItemClick,
  isAdminConfirmed,
  permissions,
}: {
  location: string;
  /** Shared nav-group expansion state, owned by the parent AppShell. */
  expanded: Set<string>;
  /** Callback to toggle a group open/closed. */
  onToggleGroup: (label: string) => void;
  onItemClick?: () => void;
  /** True once /admin/me has confirmed the session is valid admin.
   *  Keeps the inbox-counts query from firing with a 401 during the
   *  initial access-check state before adminEmail is populated. */
  isAdminConfirmed: boolean;
  /** Granular permission keys the caller holds (from /admin/me). Used
   *  to hide nav entries whose `requiredPermission` they lack. */
  permissions: ReadonlySet<string>;
}) {
  // Phase 16 — actionable-work counts powering nav badges. Cached for
  // 30s so paging through the SPA doesn't hammer the endpoint, but
  // refetched on window focus so a CSR who clears the inbox in another
  // tab sees the badge drop without reloading. Failures degrade
  // silently — badges just don't render rather than blocking the nav.
  // Gated on `isAdminConfirmed` so we don't fire a request that will
  // 401 before the session check completes.
  //
  // Live refresh (#18): poll once a minute while the console is open so
  // badges stay current during a long session without a focus change.
  // refetchIntervalInBackground stays false (the TanStack default), so
  // a hidden tab doesn't keep polling — work lands on the next focus
  // refetch instead.
  const { data: counts } = useQuery({
    queryKey: ["admin-inbox-counts"],
    queryFn: fetchAdminInboxCounts,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
    enabled: isAdminConfirmed,
  });
  // Hide nav entries whose `requiredPermission` the caller lacks, then
  // drop any group left with no visible items. A link with no
  // requiredPermission is always shown. The server-side
  // `requirePermission(...)` is the real boundary; this only avoids
  // showing a link that would 403.
  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (link) =>
        !link.requiredPermission || permissions.has(link.requiredPermission),
    ),
  })).filter((group) => group.items.length > 0);

  // Resolve "which nav link is active" once per render so a parent
  // and a child of the current location don't both highlight.
  const activeHref = pickActiveHref(location, visibleGroups);

  return (
    <div className="flex flex-col gap-2">
      {visibleGroups.map((group) => {
        const isOpen = expanded.has(group.label);
        const rolledUpBadge = isOpen
          ? 0
          : group.items.reduce(
              (sum, link) => sum + badgeCountFor(link, counts),
              0,
            );
        const sectionId = groupDomId(group.label);
        const testId = `admin-nav-group-${group.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")}`;
        return (
          <div key={group.label} className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => onToggleGroup(group.label)}
              aria-expanded={isOpen}
              aria-controls={sectionId}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] uppercase tracking-[0.22em] font-semibold hover:bg-[hsl(var(--surface-3))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--penn-gold))]"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
              data-testid={testId}
            >
              <ChevronRight
                className={`h-3 w-3 shrink-0 transition-transform duration-150 ${
                  isOpen ? "rotate-90" : ""
                }`}
                aria-hidden="true"
              />
              <span className="flex-1 text-left">{group.label}</span>
              {rolledUpBadge > 0 && (
                <span
                  className="inline-flex items-center justify-center rounded-full bg-rose-600 px-1.5 text-[9px] font-bold leading-4 text-white min-w-[1rem]"
                  aria-label={`${rolledUpBadge} pending in ${group.label}`}
                  data-testid={`${testId}-rollup-badge`}
                >
                  {rolledUpBadge > 99 ? "99+" : rolledUpBadge}
                </span>
              )}
            </button>
            <div
              id={sectionId}
              className="flex flex-col gap-0.5 pb-1"
              hidden={!isOpen}
            >
              {group.items.map((link) => (
                <div key={link.href} onClick={onItemClick}>
                  <NavItem
                    {...link}
                    isActive={activeHref === link.href}
                    badgeCount={badgeCountFor(link, counts)}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}
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
        Enroll multi-factor authentication below to access the rest of the admin
        console. This is a policy-level requirement; your team flipped it on.
      </div>
    );
  }
  return (
    <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 flex items-start justify-between gap-3">
      <div>
        <strong>Multi-factor authentication is required.</strong> You must
        enroll an authenticator app before you can keep using the admin console.
        This policy applies to every admin / CSR account.
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
  adminPermissions,
  children,
}: {
  adminEmail?: string;
  adminRole?: AdminRole;
  /**
   * Granular permission keys from `/admin/me`. Used to hide nav
   * entries whose `requiredPermission` the caller lacks. Undefined
   * during the initial access-check window → treated as empty
   * (fail-closed: gated entries stay hidden until /me resolves).
   */
  adminPermissions?: string[];
  children: ReactNode;
}) {
  const navPermissions = useMemo(
    () => new Set(adminPermissions ?? []),
    [adminPermissions],
  );
  const [location] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // ── Shared sidebar nav state ──────────────────────────────────────────────
  // Both the desktop sidebar and the mobile drawer render SidebarNavBody.
  // State lives here (not inside SidebarNavBody) so there is only one copy
  // and only one localStorage writer — preventing the CSS-hidden instance
  // from clobbering toggle changes made by the visible one.

  const activeGroup = findGroupForActiveHref(
    NAV_GROUPS,
    pickActiveHref(location, NAV_GROUPS),
  );

  const [navExpanded, setNavExpanded] = useState<Set<string>>(() =>
    loadInitialExpandedGroups(activeGroup),
  );

  // Tracks groups the user has *explicitly* collapsed so the deep-link
  // auto-expand never reopens a group the rep deliberately closed.
  // Opening a group removes it from this set.
  const [navExplicitCollapsed, setNavExplicitCollapsed] = useState<Set<string>>(
    () => loadExplicitCollapsedGroups(),
  );

  // Keep a ref so the auto-expand effect can read the current value of
  // navExplicitCollapsed without listing it as a dependency (we only want
  // to fire when activeGroup changes, not when the user manually toggles).
  const navExplicitCollapsedRef = useRef(navExplicitCollapsed);
  navExplicitCollapsedRef.current = navExplicitCollapsed;

  // Persist expanded state after every change; skip the initial mount so
  // we don't overwrite localStorage before the user has done anything.
  const skipFirstNavPersist = useRef(true);
  useEffect(() => {
    if (skipFirstNavPersist.current) {
      skipFirstNavPersist.current = false;
      return;
    }
    persistExpandedGroups(navExpanded);
  }, [navExpanded]);

  // Deep-link auto-expand: when navigation lands in a collapsed group,
  // open it — but skip both the initial mount (where loadInitialExpandedGroups
  // is already authoritative) and any group the user has explicitly collapsed.
  const skipFirstAutoExpand = useRef(true);
  useEffect(() => {
    if (skipFirstAutoExpand.current) {
      skipFirstAutoExpand.current = false;
      return;
    }
    if (!activeGroup) return;
    if (navExplicitCollapsedRef.current.has(activeGroup)) return;
    setNavExpanded((prev) => {
      if (prev.has(activeGroup)) return prev;
      const next = new Set(prev);
      next.add(activeGroup);
      return next;
    });
  }, [activeGroup]);

  function toggleNavGroup(label: string) {
    const isCurrentlyOpen = navExpanded.has(label);
    setNavExpanded((prev) => {
      const next = new Set(prev);
      if (isCurrentlyOpen) next.delete(label);
      else next.add(label);
      return next;
    });
    setNavExplicitCollapsed((prev) => {
      const next = new Set(prev);
      if (isCurrentlyOpen) {
        // User is collapsing — remember this choice so auto-expand won't
        // undo it when the rep navigates back to a link in this group.
        next.add(label);
      } else {
        // User is reopening — clear the explicit-collapse flag so future
        // deep-link auto-expand works normally again.
        next.delete(label);
      }
      persistExplicitCollapsedGroups(next);
      return next;
    });
  }
  // ── End shared sidebar nav state ──────────────────────────────────────────

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
                    expanded={navExpanded}
                    onToggleGroup={toggleNavGroup}
                    onItemClick={() => setMobileNavOpen(false)}
                    isAdminConfirmed={!!adminEmail}
                    permissions={navPermissions}
                  />
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        ) : null}
        <div className="flex-1 flex">
          {/*
          Persistent grouped sidebar — desktop only. Each section is
          a collapsible chevron-toggle; by default only the group
          containing the active route is open, so a CSR sees ~10
          items instead of all ~60. Group state is persisted to
          localStorage. Sticky inside its own scroll context so the
          nav stays visible on long detail pages, with its own inner
          scroll if a particularly small laptop viewport can't fit
          every open group at once. On <lg viewports the sidebar is
          hidden in favour of the slide-out drawer above so the
          main content can claim the full width.
        */}
          <aside
            className="sidebar-surface w-64 shrink-0 hidden lg:flex flex-col"
            aria-label="Admin navigation"
          >
            <nav
              className="flex-1 overflow-y-auto px-3 py-4 sticky top-0"
              style={{ maxHeight: "calc(100vh - 4rem)" }}
            >
              <SidebarNavBody
                location={location}
                expanded={navExpanded}
                onToggleGroup={toggleNavGroup}
                isAdminConfirmed={!!adminEmail}
                permissions={navPermissions}
              />
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

import {
  Fragment,
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
  FolderKanban,
  CalendarClock,
  CalendarDays,
  Sparkles,
  Mail,
  Users,
  CopyCheck,
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
  Stethoscope,
  Layers,
  Wind,
  FileCheck2,
  Send,
  PlayCircle,
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

// A single routable page. When it lives inside a section's `tabs`, it
// renders as a tab in the contextual sub-nav at the top of the content
// area (see SectionSubNav); when a section has no tabs the section IS the
// page and carries these fields directly.
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

// One sidebar entry. Most entries are multi-page SECTIONS: the sidebar
// shows a single line, and clicking it opens the section's landing page
// with a horizontal tab bar (`tabs`) at the top of the content area so a
// rep can move between the pages that belong together WITHOUT hunting a
// long sidebar. A handful of entries are single pages — they omit `tabs`
// and carry `href` / `matchPrefix` / `badgeKey` directly.
type NavSection = {
  /** Sidebar label. */
  label: string;
  /** Sidebar icon so reps scan visually rather than read every word. */
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Optional one-line hint shown as a `title` for new reps. */
  hint?: string;
  /** Sub-pages, rendered as the contextual sub-nav tab bar. */
  tabs?: ReadonlyArray<NavLink>;
  /** Single-page entry only: the route this links to (ignored with `tabs`). */
  href?: string;
  /** Single-page entry only: active-state prefix (defaults to `href`). */
  matchPrefix?: string;
  /** Single-page entry only: roll-up badge key. */
  badgeKey?: NavLink["badgeKey"];
  /** Permission gating the WHOLE entry (hidden if the caller lacks it). */
  requiredPermission?: string;
  /** Optional sidebar sub-cluster header within the group. */
  section?: string;
};

type NavGroup = {
  label: string;
  items: ReadonlyArray<NavSection>;
};

/*
 * Sidebar navigation, grouped by job function. Groups are
 * COLLAPSIBLE — see SidebarNavBody. Default: only the group
 * containing the current route is open; the user's per-group
 * expand/collapse state is persisted to localStorage so the
 * sidebar comes back the way they left it.
 *
 * Each group holds a SMALL set of SECTIONS rather than a long flat list
 * of links. A section that owns several related pages declares them as
 * `tabs`; the sidebar shows only the section, and the pages surface as a
 * tab bar at the top of the content (SectionSubNav). This collapses what
 * used to be ~85 sidebar links into ~23 scannable entries while keeping
 * every route reachable and deep-linkable. The six groups:
 *
 *   1. WORKSPACE  — the daily driver: home, conversations, follow-ups, outreach
 *   2. PATIENTS & CLINICAL — records, RT clinical work, therapy monitoring
 *   3. ORDERS & SHOP — fulfillment, catalog, storefront growth, leads
 *   4. BILLING    — hub, claim worklists, A/R & revenue, claims tools
 *   5. ANALYTICS & REPORTS — exports, business, customer/clinical
 *   6. SYSTEM     — automation, operations health, configuration, account
 */
const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Workspace",
    items: [
      {
        label: "Home",
        icon: LayoutDashboard,
        href: "/admin",
        matchPrefix: "/admin",
        hint: "Your day at a glance — KPIs, today's worklist, and quick links into every queue",
      },
      {
        label: "Company Calendar",
        icon: CalendarDays,
        href: "/admin/company-calendar",
        matchPrefix: "/admin/company-calendar",
        hint: "Shared schedule of patient appointments — fittings, setups, follow-ups — visible to the whole team",
      },
      {
        label: "Conversations",
        icon: MessageSquareText,
        hint: "Inbound threads, multi-channel cases, and open service episodes",
        tabs: [
          {
            href: "/admin/conversations",
            label: "Conversations",
            icon: MessageSquareText,
            matchPrefix: "/admin/conversations",
            hint: "Inbound SMS, MMS, and email threads",
            badgeKey: "awaitingReplyConversations",
          },
          {
            href: "/admin/cases",
            label: "Cases",
            icon: FolderKanban,
            matchPrefix: "/admin/cases",
            hint: "Multi-channel tickets — link the threads, orders, and faxes that belong to one issue",
            requiredPermission: "cases.read",
          },
          {
            href: "/admin/episodes",
            label: "Episodes",
            icon: ListChecks,
            matchPrefix: "/admin/episodes",
            hint: "Open service episodes that need follow-up",
          },
        ],
      },
      {
        label: "Follow-ups",
        icon: CalendarClock,
        hint: "Scheduled callbacks and patient-requested appointments",
        tabs: [
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
        ],
      },
      {
        // "Outreach" is now scoped to things you actively SEND to a
        // patient. The reusable-content editors (canned replies +
        // automated-message copy) moved to the "Templates" section
        // below, so the section no longer mixes "send" with "author".
        label: "Outreach",
        icon: Send,
        hint: "Send messages to patients — bulk campaigns, one-off alerts, resupply reminders",
        tabs: [
          {
            href: "/admin/bulk-campaigns",
            label: "Bulk Campaigns",
            icon: BellRing,
            matchPrefix: "/admin/bulk-campaigns",
            hint: "Resolve an audience, then draft and send a bulk email",
          },
          {
            href: "/admin/alerts",
            label: "Alert Library",
            icon: AlertOctagon,
            matchPrefix: "/admin/alerts",
            requiredPermission: "admin.tools.manage",
            hint: "Send a curated one-off email / SMS / phone-call alert to a patient",
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
        // Reusable message CONTENT (authoring/config), split out from
        // "Outreach" so the near-synonym labels stop competing: canned
        // replies are snippets a CSR inserts manually; automated
        // messages are the system-sent copy. Both are admin.tools.manage
        // gated, so this whole section is hidden from plain CSRs.
        label: "Templates",
        icon: Mail,
        hint: "Reusable message content — manual reply snippets and automated-message copy",
        tabs: [
          {
            href: "/admin/macros",
            label: "Canned Replies",
            icon: Sparkles,
            matchPrefix: "/admin/macros",
            requiredPermission: "admin.tools.manage",
            hint: "Saved snippets a CSR inserts into a manual conversation reply",
          },
          {
            href: "/admin/templates",
            label: "Automated messages",
            icon: Mail,
            matchPrefix: "/admin/templates",
            requiredPermission: "admin.tools.manage",
            hint: "Edit the copy used by automated, system-sent customer messages",
          },
        ],
      },
    ],
  },
  {
    label: "Patients & Clinical",
    items: [
      {
        label: "Patients",
        icon: Users,
        href: "/admin/patients",
        matchPrefix: "/admin/patients",
        hint: "Patient roster, profiles, and 360 view",
        badgeKey: "newPatientDocuments",
      },
      {
        label: "Document packets",
        icon: FileCheck2,
        href: "/admin/patient-packets",
        matchPrefix: "/admin/patient-packets",
        hint: "Send & track e-signature packets for new patients",
      },
      {
        label: "Duplicate review",
        icon: CopyCheck,
        href: "/admin/patients/duplicates",
        matchPrefix: "/admin/patients/duplicates",
        hint: "Find and reconcile likely-duplicate patient records",
      },
      {
        label: "Clinical work",
        icon: Stethoscope,
        hint: "RT clinical work — encounters, interventions, mask-fit, coaching",
        tabs: [
          {
            href: "/admin/clinical",
            label: "Clinical encounters",
            icon: HeartPulse,
            matchPrefix: "/admin/clinical",
            requiredPermission: "clinical.read",
            hint: "Document + review patient clinical encounters (RT)",
          },
          {
            href: "/admin/clinical/interventions",
            label: "Interventions",
            icon: Activity,
            matchPrefix: "/admin/clinical/interventions",
            requiredPermission: "clinical.read",
            hint: "Non-adherence intervention worklist — cause, plan, outcome",
          },
          {
            href: "/admin/clinical/mask-fit",
            label: "Mask-fit feedback",
            icon: Wind,
            matchPrefix: "/admin/clinical/mask-fit",
            requiredPermission: "clinical.read",
            hint: "Patients reporting a leaking / uncomfortable fit — triage to follow-up",
          },
          {
            href: "/admin/clinical/outreach",
            label: "Clinical outreach",
            icon: Send,
            matchPrefix: "/admin/clinical/outreach",
            requiredPermission: "clinical.read",
            hint: "Send supportive check-ins to patients with an open intervention (consent/DND-gated)",
          },
          {
            href: "/admin/coaching",
            label: "Adherence coaching",
            icon: HeartPulse,
            matchPrefix: "/admin/coaching",
            hint: "Outreach plans for patients with slipping CPAP adherence",
          },
          {
            href: "/admin/clinical/education-videos",
            label: "Video library",
            icon: PlayCircle,
            matchPrefix: "/admin/clinical/education-videos",
            requiredPermission: "reports.read",
            hint: "Manage the short-video education library shown on the storefront /learn pages",
          },
        ],
      },
      {
        label: "Therapy monitoring",
        icon: HeartPulse,
        hint: "Population therapy monitoring — adherence board, RT outcomes, fleet, resupply",
        tabs: [
          {
            href: "/admin/rt-overview",
            label: "RT Overview",
            icon: HeartPulse,
            matchPrefix: "/admin/rt-overview",
            hint: "At-a-glance therapy board: alerts, AHI, leak, usage",
          },
          {
            href: "/admin/rt-outcomes",
            label: "RT outcomes",
            icon: Stethoscope,
            matchPrefix: "/admin/rt-outcomes",
            requiredPermission: "clinical.read",
            hint: "Per-therapist activity: encounters, patients, interventions",
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
        ],
      },
      {
        label: "Providers & records",
        icon: HeartHandshake,
        hint: "Provider registry, inbound faxes, referrals, equipment recalls",
        tabs: [
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
    ],
  },
  {
    label: "Orders & Shop",
    items: [
      {
        label: "Orders",
        icon: ShoppingBag,
        hint: "Storefront fulfillment — orders, subscriptions, returns, backorders",
        tabs: [
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
        ],
      },
      {
        label: "Inventory",
        icon: Boxes,
        hint: "Catalog, stock levels, product editor, monthly reconciliation",
        tabs: [
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
        label: "Storefront",
        icon: ShoppingCart,
        hint: "Shop accounts, reviews, product Q&A, abandoned carts, back-in-stock",
        tabs: [
          {
            href: "/admin/shop/customers",
            label: "Customers",
            icon: UsersRound,
            matchPrefix: "/admin/shop/customers",
            hint: "Registered shop accounts, with clinical info + in-app messaging",
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
        ],
      },
      {
        label: "Leads",
        icon: UsersRound,
        hint: "Benefit-verification requests and fitter prospect funnel",
        tabs: [
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
        ],
      },
    ],
  },
  {
    label: "Billing",
    items: [
      {
        label: "Billing Hub",
        icon: CircleDollarSign,
        href: "/admin/billing",
        matchPrefix: "/admin/billing",
        hint: "AR director dashboard — KPIs, money in flight, top payers",
      },
      {
        label: "Worklists",
        icon: ListChecks,
        hint: "Daily billing worklists — AI queue, eligibility, prior auths, denials, CMN",
        tabs: [
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
            requiredPermission: "reports.read",
            hint: "Active coverages due for re-verification — never-checked, terminating soon, or stale",
          },
          {
            href: "/admin/billing/auto-submit",
            label: "Auto-submit",
            icon: Send,
            matchPrefix: "/admin/billing/auto-submit",
            requiredPermission: "admin.tools.manage",
            hint: "Claims ready to transmit — preflight-clean + active eligibility. Approve a batch or let the cron send them.",
          },
          {
            href: "/admin/billing/prior-auths",
            label: "Prior auths",
            icon: ShieldAlert,
            matchPrefix: "/admin/billing/prior-auths",
            hint: "Missed / at-risk SLA + auths expiring soon + drafts to submit",
          },
          {
            href: "/admin/billing/denials-worklist",
            label: "Denials worklist",
            icon: Gavel,
            matchPrefix: "/admin/billing/denials-worklist",
            requiredPermission: "reports.read",
            hint: "Open denials ranked by recoverable $ × win-probability",
          },
          {
            href: "/admin/billing/cmn",
            label: "CMN / DIF worklist",
            icon: FileCheck2,
            matchPrefix: "/admin/billing/cmn",
            requiredPermission: "reports.read",
            hint: "Draft Certificates of Medical Necessity awaiting completion",
          },
        ],
      },
      {
        // Split out of the old "A/R & revenue" grab-bag: the actionable
        // money-collection worklists (work these to get paid). The pure
        // revenue dashboards moved to "Revenue analytics" below, so this
        // section stops mixing "do something" with "read a metric".
        label: "A/R & collections",
        icon: Landmark,
        hint: "Work claims to get paid — aging, filing deadlines, secondary claims, statements, capped rentals",
        tabs: [
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
            href: "/admin/billing/secondary",
            label: "Secondary claims",
            icon: Layers,
            matchPrefix: "/admin/billing/secondary",
            requiredPermission: "reports.read",
            hint: "Coordination of benefits — roll the primary's leftover balance to the secondary payer",
          },
          {
            href: "/admin/billing/statements",
            label: "Statement send",
            icon: Mail,
            matchPrefix: "/admin/billing/statements",
            requiredPermission: "reports.read",
            hint: "Send patient-responsibility statements (email/SMS) — consent + quiet-hours aware",
          },
          {
            href: "/admin/billing/capped-rentals",
            label: "Capped rentals",
            icon: CalendarRange,
            matchPrefix: "/admin/billing/capped-rentals",
            hint: "13- and 36-month CMS rental cycle tracker + KH/KI/KX modifier rotation",
          },
        ],
      },
      {
        label: "Revenue analytics",
        icon: TrendingUp,
        hint: "Read-only revenue dashboards — denial rate & DSO, collections forecast, payer profitability",
        tabs: [
          {
            href: "/admin/billing/denials",
            label: "Denials & DSO",
            icon: TrendingDown,
            matchPrefix: "/admin/billing/denials",
            hint: "90-day denial rate + 180-day days-to-pay, per payer",
          },
          {
            href: "/admin/billing/collections-forecast",
            label: "Collections forecast",
            icon: TrendingUp,
            matchPrefix: "/admin/billing/collections-forecast",
            requiredPermission: "reports.read",
            hint: "Projected cash from claims in flight, bucketed by expected landing date",
          },
          {
            href: "/admin/billing/payer-profitability",
            label: "Payer profitability",
            icon: Landmark,
            matchPrefix: "/admin/billing/payer-profitability",
            requiredPermission: "cost.read",
            hint: "Net yield by payer: billed → allowed → collected, denial rate, net of cost",
          },
        ],
      },
      {
        label: "Tools",
        icon: SlidersHorizontal,
        hint: "ERA posting, manual claim entry, and billing configuration",
        tabs: [
          {
            href: "/admin/billing/era",
            label: "ERA files",
            icon: Wallet,
            matchPrefix: "/admin/billing/era",
            hint: "Upload an 835 to auto-post payer adjudications",
          },
          {
            href: "/admin/billing/manual-claim",
            label: "Manual claim",
            icon: FilePlus2,
            matchPrefix: "/admin/billing/manual-claim",
            requiredPermission: "patients.update",
            hint: "Key a corrected / void-replacement / paper-backup claim by hand",
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
    ],
  },
  {
    label: "Analytics & Reports",
    items: [
      {
        label: "Reports",
        icon: BarChart3,
        href: "/admin/reports",
        matchPrefix: "/admin/reports",
        hint: "CSV, PDF, and QuickBooks (IIF / QBO) exports for ops and finance",
      },
      {
        // Was the catch-all "Business" section; split into Financial vs
        // Performance & goals so cost economics and team/KPI tracking
        // stop sharing one grab-bag list.
        label: "Financial",
        icon: TrendingUp,
        hint: "Captured-cost economics — margin, LTV/CAC, inventory turnover",
        tabs: [
          {
            href: "/admin/analytics/margin",
            label: "Margin & COGS",
            icon: CircleDollarSign,
            matchPrefix: "/admin/analytics/margin",
            requiredPermission: "cost.read",
            hint: "Gross margin and % by product and overall, from captured cost",
          },
          {
            href: "/admin/analytics/outreach-attribution",
            label: "Outreach Attribution",
            icon: Target,
            matchPrefix: "/admin/analytics/outreach-attribution",
            requiredPermission: "reports.read",
            hint: "Share of contacted patients who ordered, by outreach channel",
          },
          {
            href: "/admin/analytics/revenue-by-source",
            label: "Revenue by source",
            icon: BarChart3,
            matchPrefix: "/admin/analytics/revenue-by-source",
            requiredPermission: "reports.read",
            hint: "Order volume + cash revenue by channel (storefront / resupply / clinical form)",
          },
          {
            href: "/admin/analytics/ltv-cac",
            label: "LTV & CAC",
            icon: TrendingUp,
            matchPrefix: "/admin/analytics/ltv-cac",
            requiredPermission: "cost.read",
            hint: "Lifetime value vs acquisition cost by channel, with LTV:CAC",
          },
          {
            href: "/admin/analytics/inventory-turnover",
            label: "Inventory turnover",
            icon: Boxes,
            matchPrefix: "/admin/analytics/inventory-turnover",
            requiredPermission: "cost.read",
            hint: "Turnover (COGS ÷ inventory value) + stockout demand per SKU",
          },
        ],
      },
      {
        label: "Performance & goals",
        icon: Target,
        hint: "Team throughput, KPI targets, and threshold alerts",
        tabs: [
          {
            href: "/admin/productivity",
            label: "Team throughput",
            icon: Activity,
            matchPrefix: "/admin/productivity",
            hint: "Per-agent close / approve / resolve counts",
          },
          {
            href: "/admin/live-staffing",
            label: "Live staffing",
            icon: Users,
            matchPrefix: "/admin/live-staffing",
            hint: "Real-time open-conversation load per agent + backlog",
          },
          {
            href: "/admin/goals",
            label: "Goals & targets",
            icon: Target,
            matchPrefix: "/admin/goals",
            requiredPermission: "targets.manage",
            hint: "Set KPI targets per period and track pace-to-goal vs. actuals",
          },
          {
            href: "/admin/kpi-alerts",
            label: "KPI alerts",
            icon: BellRing,
            matchPrefix: "/admin/kpi-alerts",
            requiredPermission: "metrics.read",
            hint: "KPI threshold alert feed + rule config (revenue, denials, churn)",
          },
        ],
      },
      {
        label: "Clinical & customer",
        icon: Activity,
        hint: "Resupply funnel & compliance, provider therapy report, customer NPS, storefront traffic",
        tabs: [
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
        ],
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Automation",
        icon: ScrollText,
        hint: "Automation rules and the rule dry-run tester",
        tabs: [
          {
            href: "/admin/rules",
            label: "Rules",
            icon: ScrollText,
            matchPrefix: "/admin/rules",
            hint: "Automation rules that trigger replies & actions",
          },
          {
            href: "/admin/compliance-rules",
            label: "Compliance Rules",
            icon: ShieldCheck,
            matchPrefix: "/admin/compliance-rules",
            hint: "Per-payer CPAP adherence thresholds (min hours / nights)",
          },
          {
            href: "/admin/rule-tester",
            label: "Rule Tester",
            icon: FlaskConical,
            matchPrefix: "/admin/rule-tester",
            hint: "Dry-run a rule against sample input",
          },
        ],
      },
      {
        label: "Operations",
        icon: Activity,
        hint: "Background job health, integrations, delivery failures, webhooks",
        tabs: [
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
            requiredPermission: "admin.tools.manage",
            hint: "Outbound event deliveries to partner endpoints — re-queue failed/exhausted sends",
          },
        ],
      },
      {
        label: "Settings",
        icon: Settings,
        hint: "Practice settings, feature control center, closures, team accounts",
        tabs: [
          {
            href: "/admin/settings",
            label: "Settings",
            icon: Settings,
            matchPrefix: "/admin/settings",
            hint: "Practice settings & integrations",
          },
          {
            href: "/admin/account-setup",
            label: "Account Setup",
            icon: ClipboardCheck,
            matchPrefix: "/admin/account-setup",
            hint: "New-account / production launch checklist",
          },
          {
            href: "/admin/control-center",
            label: "Control Center",
            icon: ToggleLeft,
            matchPrefix: "/admin/control-center",
            hint: "On/off switches for major features (voice, SMS, campaigns, AI billing, …)",
          },
          {
            href: "/admin/connection-tests",
            label: "Connection tests",
            icon: Plug,
            matchPrefix: "/admin/connection-tests",
            requiredPermission: "system.config.manage",
            hint: "Send a real test email, SMS, voice call, or AI chat to confirm credentials work (super-admin)",
          },
          {
            href: "/admin/system/configuration",
            label: "Configuration & tests",
            icon: SlidersHorizontal,
            matchPrefix: "/admin/system/configuration",
            requiredPermission: "system.config.manage",
            hint: "Integration credentials & platform secrets, plus send-a-test for email/SMS/voice/chat (super-admin)",
          },
          {
            href: "/admin/closures",
            label: "Closures",
            icon: CalendarOff,
            matchPrefix: "/admin/closures",
            hint: "Holidays and weather closures with inbound-SMS auto-reply",
          },
          {
            href: "/admin/team",
            label: "Team",
            icon: UsersRound,
            matchPrefix: "/admin/team",
            hint: "Manage admin & agent accounts",
          },
        ],
      },
      {
        label: "Account",
        icon: ShieldCheck,
        hint: "Your own security settings",
        tabs: [
          {
            href: "/admin/security",
            label: "Account security",
            icon: ShieldCheck,
            matchPrefix: "/admin/security",
            hint: "Manage your own MFA / authenticator-app enrollment",
          },
        ],
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

function linkMatchesLocation(location: string, prefix: string): boolean {
  // The Dashboard ("/admin") target is exact-only — the bare /admin
  // route shouldn't claim every /admin/* subpath.
  if (prefix === "/admin") {
    return location === "/admin" || location === "/admin/";
  }
  return location === prefix || location.startsWith(`${prefix}/`);
}

type FlatTarget = {
  prefix: string;
  href: string;
  group: NavGroup;
  section: NavSection;
  tab?: NavLink;
};

/**
 * Every routable target (each tab, plus single-page entries) flattened
 * with a back-reference to its owning section + group, so active-route
 * detection is a single longest-prefix pass.
 */
function flattenTargets(groups: ReadonlyArray<NavGroup>): FlatTarget[] {
  const out: FlatTarget[] = [];
  for (const group of groups) {
    for (const section of group.items) {
      if (section.tabs && section.tabs.length > 0) {
        for (const tab of section.tabs) {
          out.push({
            prefix: tab.matchPrefix ?? tab.href,
            href: tab.href,
            group,
            section,
            tab,
          });
        }
      } else if (section.href) {
        out.push({
          prefix: section.matchPrefix ?? section.href,
          href: section.href,
          group,
          section,
        });
      }
    }
  }
  return out;
}

/**
 * Longest-prefix-wins active selection. When a section landing
 * ("Billing Hub" @ /admin/billing) and a deeper tab ("AI queue" @
 * /admin/billing/ai-queue) both match the current location, only the
 * more specific one wins. Ties go to the first seen (NAV_GROUPS order).
 */
function pickActiveTarget(
  location: string,
  groups: ReadonlyArray<NavGroup>,
): FlatTarget | null {
  let best: { target: FlatTarget; specificity: number } | null = null;
  for (const target of flattenTargets(groups)) {
    if (!linkMatchesLocation(location, target.prefix)) continue;
    const specificity = target.prefix.length;
    if (!best || specificity > best.specificity) {
      best = { target, specificity };
    }
  }
  return best?.target ?? null;
}

/**
 * The active tab/section href. Kept as a named helper the AppShell and
 * the nav tests reference.
 */
function pickActiveHref(
  location: string,
  groups: ReadonlyArray<NavGroup>,
): string | null {
  const target = pickActiveTarget(location, groups);
  if (!target) return null;
  return target.tab?.href ?? target.href;
}

/**
 * Find which NAV_GROUPS group owns the currently-active route, so that
 * group can be auto-expanded for a rep who deep-links into a collapsed
 * section.
 */
function findGroupForActiveHref(
  groups: ReadonlyArray<NavGroup>,
  activeHref: string | null,
): string | null {
  if (!activeHref) return null;
  for (const group of groups) {
    for (const section of group.items) {
      if (section.href === activeHref) return group.label;
      if (section.tabs?.some((tab) => tab.href === activeHref)) {
        return group.label;
      }
    }
  }
  return null;
}

/** Tabs of a section the caller is allowed to open. */
function visibleTabs(
  section: NavSection,
  permissions: ReadonlySet<string>,
): ReadonlyArray<NavLink> {
  if (!section.tabs) return [];
  return section.tabs.filter(
    (tab) => !tab.requiredPermission || permissions.has(tab.requiredPermission),
  );
}

/**
 * Where the sidebar entry links: the first tab the caller can actually
 * see (so a CSR never lands on a tab that 403s), or the single-page href.
 */
function sectionLandingHref(
  section: NavSection,
  permissions: ReadonlySet<string>,
): string {
  if (section.tabs && section.tabs.length > 0) {
    const visible = visibleTabs(section, permissions);
    return (visible[0] ?? section.tabs[0]!).href;
  }
  return section.href ?? "#";
}

/** Whether the caller may see this sidebar entry at all. */
function sectionVisible(
  section: NavSection,
  permissions: ReadonlySet<string>,
): boolean {
  if (
    section.requiredPermission &&
    !permissions.has(section.requiredPermission)
  ) {
    return false;
  }
  if (section.tabs && section.tabs.length > 0) {
    return visibleTabs(section, permissions).length > 0;
  }
  return true;
}

/**
 * Total actionable-work badge for a sidebar entry: its own badge plus the
 * rolled-up badges of every tab the caller can see.
 */
function sectionBadgeCount(
  section: NavSection,
  counts: AdminInboxCounts | undefined,
  permissions: ReadonlySet<string>,
): number {
  let total = section.badgeKey ? (counts?.[section.badgeKey] ?? 0) : 0;
  for (const tab of visibleTabs(section, permissions)) {
    if (tab.badgeKey) total += counts?.[tab.badgeKey] ?? 0;
  }
  return total;
}

const NAV_EXPANDED_STORAGE_KEY = "pf-admin-nav-expanded-groups";
const NAV_EXPLICIT_COLLAPSED_STORAGE_KEY =
  "pf-admin-nav-explicit-collapsed-groups";

// Migration map for renamed nav groups to preserve user sidebar state
// across deployments when group labels change.
const NAV_GROUP_LABEL_MIGRATION: Record<string, string> = {
  Inbox: "Workspace",
  Customers: "Patients & Clinical",
  Insights: "Analytics & Reports",
};

function loadInitialExpandedGroups(activeGroup: string | null): Set<string> {
  const fallback = new Set(activeGroup ? [activeGroup] : []);
  const validGroups = new Set(NAV_GROUPS.map((group) => group.label));
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(NAV_EXPANDED_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((s): s is string => typeof s === "string")
    ) {
      const migrated = new Set(
        parsed
          .map((label) => NAV_GROUP_LABEL_MIGRATION[label] ?? label)
          .filter((label) => validGroups.has(label)),
      );
      return migrated.size > 0 ? migrated : fallback;
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
      // Migrate old group labels to new ones
      const migrated = parsed.map(
        (label) => NAV_GROUP_LABEL_MIGRATION[label] ?? label,
      );
      return new Set(migrated);
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
  // drop any group left with no visible items. An entry with no
  // requiredPermission (and at least one visible tab) is always shown.
  // The server-side `requirePermission(...)` is the real boundary; this
  // only avoids showing a link that would 403.
  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((link) => sectionVisible(link, permissions)),
  })).filter((group) => group.items.length > 0);

  // Resolve "which sidebar entry is active" once per render so a section
  // and one of its tabs don't both highlight.
  const activeSection = pickActiveTarget(location, visibleGroups)?.section;

  return (
    <div className="flex flex-col gap-2">
      {visibleGroups.map((group) => {
        const isOpen = expanded.has(group.label);
        const rolledUpBadge = isOpen
          ? 0
          : group.items.reduce(
              (sum, link) => sum + sectionBadgeCount(link, counts, permissions),
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
              {group.items.map((link, idx) => {
                // Emit a muted sub-header when this item starts a new
                // section, so a long group renders as a few labelled
                // clusters. Items sharing a section must stay contiguous.
                const section = link.section;
                const showSectionHeader =
                  !!section && section !== group.items[idx - 1]?.section;
                const groupSlug = group.label
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-");
                const href = sectionLandingHref(link, permissions);
                return (
                  <Fragment key={link.label}>
                    {showSectionHeader && section ? (
                      <p
                        className="px-3 pt-3 pb-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--ink-muted))] first:pt-0.5"
                        data-testid={`admin-nav-subsection-${groupSlug}-${section
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "-")}`}
                      >
                        {section}
                      </p>
                    ) : null}
                    <div onClick={onItemClick}>
                      <NavItem
                        href={href}
                        label={link.label}
                        icon={link.icon}
                        hint={link.hint}
                        isActive={link === activeSection}
                        badgeCount={sectionBadgeCount(
                          link,
                          counts,
                          permissions,
                        )}
                      />
                    </div>
                  </Fragment>
                );
              })}
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

/**
 * Contextual sub-navigation. Rendered at the top of the content area, it
 * shows the tabs of whichever section owns the current route — so a rep
 * inside Billing sees AI queue / Eligibility / Prior auths / … as a tab
 * bar instead of every billing page living in the sidebar. This is the
 * mechanism that lets the sidebar collapse from ~85 links to ~23 section
 * entries while keeping every page one click away and deep-linkable.
 *
 * Renders nothing when the active entry is a single page (no tabs) or has
 * only one tab the caller can see. Permission-gated tabs are filtered the
 * same way the sidebar filters sections.
 */
function SectionSubNav({
  location,
  isAdminConfirmed,
  permissions,
}: {
  location: string;
  isAdminConfirmed: boolean;
  permissions: ReadonlySet<string>;
}) {
  // Reuses the same query key as the sidebar, so TanStack serves it from
  // cache — no extra request, badges stay in lockstep with the sidebar.
  const { data: counts } = useQuery({
    queryKey: ["admin-inbox-counts"],
    queryFn: fetchAdminInboxCounts,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
    enabled: isAdminConfirmed,
  });

  const active = pickActiveTarget(location, NAV_GROUPS);
  if (!active?.section.tabs) return null;
  const tabs = visibleTabs(active.section, permissions);
  if (tabs.length <= 1) return null;

  // Determine the active tab from the *visible* tabs so permission-gated
  // routes don't leave the sub-nav with nothing selected.
  let activeHref = tabs[0]!.href;
  let bestSpecificity = 0;
  for (const tab of tabs) {
    const prefix = tab.matchPrefix ?? tab.href;
    if (!linkMatchesLocation(location, prefix)) continue;
    const specificity = prefix.length;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      activeHref = tab.href;
    }
  }
  return (
    <div
      className="mb-5 border-b border-[hsl(var(--border))]"
      data-testid="admin-subnav"
    >
      <nav
        aria-label={`${active.section.label} pages`}
        className="-mb-px flex flex-wrap items-center gap-x-1 gap-y-0.5 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const isActive = tab.href === activeHref;
          const Icon = tab.icon;
          const badge = badgeCountFor(tab, counts);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              title={tab.hint}
              aria-current={isActive ? "page" : undefined}
              data-testid={`admin-subnav-${tab.href
                .replace(/\//g, "-")
                .replace(/^-/, "")}`}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "border-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))]"
                  : "border-transparent text-[hsl(var(--ink-muted))] hover:border-[hsl(var(--border))] hover:text-[hsl(var(--penn-navy))]"
              }`}
            >
              <Icon
                className="h-4 w-4 shrink-0 opacity-90"
                aria-hidden="true"
              />
              <span>{tab.label}</span>
              {badge > 0 && (
                <span
                  className="ml-1 inline-flex items-center justify-center rounded-full bg-rose-600 px-1.5 text-[10px] font-bold leading-4 text-white min-w-[1.1rem]"
                  aria-label={`${badge} pending`}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
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
          containing the active route is open, so a CSR sees ~4
          section entries instead of ~85 links. Group state is
          persisted to localStorage. Sticky inside its own scroll
          context so the nav stays visible on long detail pages, with
          its own inner scroll if a particularly small laptop viewport
          can't fit every open group at once. On <lg viewports the
          sidebar is hidden in favour of the slide-out drawer above so
          the main content can claim the full width.
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
            {/*
            Contextual sub-nav tab bar for the active section (e.g. the
            billing worklists, the clinical pages). Self-gates: renders
            nothing for single-page entries. Admin-only — never shown to
            signed-out visitors.
          */}
            {adminEmail ? (
              <SectionSubNav
                location={location}
                isAdminConfirmed={!!adminEmail}
                permissions={navPermissions}
              />
            ) : null}
            {children}
          </main>
        </div>
        <BrandFooter />
      </div>
    </RoleProvider>
  );
}

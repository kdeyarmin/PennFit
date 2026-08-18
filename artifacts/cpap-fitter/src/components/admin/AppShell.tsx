import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  fetchAdminInboxCounts,
  type AdminInboxCounts,
} from "@/lib/admin/inbox-counts-api";
import {
  featureHidingLocation,
  filterNavGroupsByFeature,
  findGroupForActiveHref,
  linkMatchesLocation,
  pickActiveHref,
  pickActiveTarget,
  sectionBadgeCount,
  sectionLandingHref,
  sectionVisible,
  visibleTabs,
  type NavGroup,
  type NavLink,
} from "./nav-traversal";
import { appModuleLabel } from "@/lib/admin/app-modules";
import {
  LayoutDashboard,
  LifeBuoy,
  Store,
  Printer,
  PhoneCall,
  Inbox,
  MessageSquareText,
  ListChecks,
  FolderKanban,
  CalendarClock,
  CalendarDays,
  Video,
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
  TruckIcon,
  Activity,
  BarChart3,
  BellRing,
  ScrollText,
  ShieldCheck,
  ScanSearch,
  FlaskConical,
  UsersRound,
  ScanFace,
  Settings,
  MapPin,
  Plug,
  Webhook,
  Target,
  Menu,
  CircleDollarSign,
  StickyNote,
  Landmark,
  Gavel,
  FilePlus2,
  Wallet,
  Bot,
  ListFilter,
  Library,
  TrendingDown,
  TrendingUp,
  ClipboardCheck,
  ShieldAlert,
  EyeOff,
  SlidersHorizontal,
  CalendarRange,
  ToggleLeft,
  ChevronRight,
  Stethoscope,
  Layers,
  Wind,
  FileCheck2,
  FileSignature,
  FileLock2,
  Send,
  PlayCircle,
  BookOpenCheck,
  Building2,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { toast } from "@/hooks/use-toast";
import { useDashboardIdentity } from "@/lib/admin/identity";
import {
  useGetAdminMe,
  useStopImpersonation,
} from "@workspace/api-client-react/admin";
import { getMfaStatus } from "@/lib/admin/mfa-api";
import { startTenantCheckout } from "@/lib/admin/platform-billing-api";

// Client-side nav-visibility token (NOT a server permission) gating the
// Locations entry. Injected into the nav permission set when /me reports
// the multi-branch feature is enabled; the entry stays hidden otherwise.
const MULTI_LOCATION_NAV_TOKEN = "feature:multi_location";
import { BrandHeader, BrandFooter } from "./BrandHeader";
import { GlobalLookup } from "./GlobalLookup";
import { AdminAssistantWidget } from "./AdminAssistantWidget";
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

// The nav model types (NavLink / NavSection / NavGroup / FlatTarget) and
// the pure traversal helpers live in ./nav-traversal and are imported at
// the top of this file.

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
 * used to be ~85 sidebar links into 24 scannable entries while keeping
 * every route reachable and deep-linkable. Sections are organized around
 * WORKFLOWS (the paperwork pipeline, the schedule, money dashboards) so
 * a rep finds the next step of a job under the same entry as the last
 * one. The six groups:
 *
 *   1. WORKSPACE  — the daily driver: home, conversations, schedule, outreach
 *   2. PATIENTS & CLINICAL — records, documents & e-sign, therapy
 *      monitoring, RT clinical work, providers
 *   3. ORDERS & SHOP — fulfillment, inventory, storefront & leads
 *   4. BILLING    — money dashboards, claim worklists, A/R & collections, tools
 *   5. ANALYTICS & REPORTS — exports, financial, performance, customer/clinical
 *   6. SYSTEM     — automation, operations health, settings, setup & advanced
 */
// Exported so the app-module invariant test can assert against the REAL
// nav data — that switching every module off still leaves the console's
// escape hatches (Home, Settings, Team, Control Center, the plan page)
// reachable — instead of string-matching this file's source.
export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
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
        label: "Front Desk",
        requiredFeature: "module.front_desk",
        icon: Store,
        href: "/admin/front-desk",
        matchPrefix: "/admin/front-desk",
        hint: "Capture a walk-in customer and ring up a counter order in real time",
        requiredPermission: "orders.create",
      },
      {
        label: "Conversations",
        requiredFeature: "module.conversations",
        icon: MessageSquareText,
        hint: "Inbound threads, multi-channel cases, and open service episodes",
        tabs: [
          {
            href: "/admin/conversations",
            label: "Conversations",
            icon: MessageSquareText,
            matchPrefix: "/admin/conversations",
            // Email Inbox was a read-only duplicate of this list (email
            // threads already live here); filter to channel=email for the old
            // email-only view. /admin/email-inbox redirects here.
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
        // One time-based home: the shared calendar plus the
        // date-driven callback queue that used to be a separate
        // sidebar entry.
        label: "Schedule",
        requiredFeature: "module.schedule",
        icon: CalendarDays,
        hint: "The shared company calendar and scheduled callbacks",
        tabs: [
          {
            href: "/admin/company-calendar",
            label: "Company Calendar",
            icon: CalendarDays,
            matchPrefix: "/admin/company-calendar",
            hint: "Shared schedule of patient appointments — fittings, setups, follow-ups — visible to the whole team",
          },
          {
            href: "/admin/video-visits",
            label: "Video visits",
            icon: Video,
            matchPrefix: "/admin/video-visits",
            hint: "Telehealth video calls with patients for equipment setups, troubleshooting, and follow-ups",
          },
          {
            href: "/admin/followups",
            label: "Follow-ups",
            icon: CalendarClock,
            matchPrefix: "/admin/followups",
            hint: "Today's queue of CSR-scheduled callbacks across customers and patients",
            badgeKey: "overdueFollowups",
          },
        ],
      },
      {
        // Everything message-shaped that ISN'T an inbound thread. The
        // send surfaces (campaigns, alerts, reminders) lead; the
        // reusable content behind them (canned replies + automated
        // message copy) trails as admin.tools.manage-gated tabs, so a
        // plain CSR sees only the send tabs. One "messages out" entry
        // instead of the old Outreach/Templates near-synonym pair.
        label: "Outreach",
        requiredFeature: "module.outreach",
        icon: Send,
        hint: "Send messages to patients — campaigns, alerts, reminders — and manage the reusable content behind them",
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
          {
            href: "/admin/playbooks",
            label: "Playbooks",
            icon: BookOpenCheck,
            matchPrefix: "/admin/playbooks",
            hint: "Situation-based contact templates — cadence + wording for SMS, email, and call outreach",
          },
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
        hint: "Patient roster, profiles, 360 view, and duplicate-record cleanup",
        tabs: [
          {
            href: "/admin/patients",
            label: "Patients",
            icon: Users,
            matchPrefix: "/admin/patients",
            hint: "Patient roster, profiles, and 360 view",
            badgeKey: "newPatientDocuments",
          },
          {
            href: "/admin/patients/duplicates",
            label: "Duplicate review",
            icon: CopyCheck,
            matchPrefix: "/admin/patients/duplicates",
            hint: "Find and reconcile likely-duplicate patient records",
          },
        ],
      },
      {
        // The paperwork pipeline, in workflow order: draft a document →
        // send a packet → track what's out for signature → the provider
        // e-sign portal → returned faxes to file. These were five
        // scattered sidebar entries; they're one job.
        label: "Documents & e-sign",
        requiredFeature: "module.documents",
        icon: FileSignature,
        hint: "The paperwork pipeline — draft documents, send packets, track signatures, file returned faxes",
        tabs: [
          {
            href: "/admin/documents",
            label: "Documents",
            icon: FilePlus2,
            matchPrefix: "/admin/documents",
            hint: "Type out a CMN, prescription, agreement, or fax cover by hand",
          },
          {
            href: "/admin/patient-packets",
            label: "Document packets",
            icon: FileCheck2,
            matchPrefix: "/admin/patient-packets",
            hint: "Send & track e-signature packets for new patients",
          },
          {
            href: "/admin/signature-tracking",
            label: "Awaiting signatures",
            icon: FileSignature,
            matchPrefix: "/admin/signature-tracking",
            hint: "Track documents out for a provider signature; scan returned faxes to file them",
          },
          {
            href: "/admin/provider-portal",
            label: "E-signature portal",
            icon: ShieldCheck,
            matchPrefix: "/admin/provider-portal",
            hint: "Provider e-signatures — stage docs, track signed items, print the audit log",
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
            href: "/admin/referral-reviews",
            label: "Referral reviewer",
            icon: FilePlus2,
            matchPrefix: "/admin/referral-reviews",
            hint: "AI-extracted intake from faxed or uploaded referral packets — review, verify insurance, and accept into a new patient record",
          },
          {
            href: "/admin/referral-sources",
            label: "Referral sources",
            icon: HeartHandshake,
            matchPrefix: "/admin/referral-sources",
            hint: "Referral-source scorecard — claim volume, patients, and paid revenue by referring physician — plus a rep-visit/call activity log",
          },
        ],
      },
      {
        // Monitoring comes before clinical work: the population boards
        // surface the patients who need attention; the clinical-work
        // worklists are where the RT acts on what the boards surfaced.
        label: "Therapy monitoring",
        requiredFeature: "module.therapy",
        icon: HeartPulse,
        hint: "Population therapy monitoring — adherence board, fleet, setups, resupply, RT outcomes",
        tabs: [
          {
            href: "/admin/rt-overview",
            label: "RT Overview",
            icon: HeartPulse,
            matchPrefix: "/admin/rt-overview",
            hint: "At-a-glance therapy board: alerts, AHI, leak, usage",
          },
          {
            href: "/admin/therapy-fleet",
            label: "Therapy Fleet",
            icon: HeartPulse,
            matchPrefix: "/admin/therapy-fleet",
            hint: "Population compliance cohorts and clinical outreach worklist",
          },
          {
            href: "/admin/therapy-compliance",
            label: "Setup Adherence",
            icon: ClipboardCheck,
            matchPrefix: "/admin/therapy-compliance",
            hint: "CMS 90-day adherence tracker for new Medicare setups",
          },
          {
            href: "/admin/therapy-resupply",
            label: "Resupply Opportunities",
            icon: PackageCheck,
            matchPrefix: "/admin/therapy-resupply",
            hint: "Device-reported supplies due for replacement — drives resupply orders",
          },
          {
            href: "/admin/rt-outcomes",
            label: "RT outcomes",
            icon: Stethoscope,
            matchPrefix: "/admin/rt-outcomes",
            requiredPermission: "clinical.read",
            hint: "Per-therapist activity: encounters, patients, interventions",
          },
        ],
      },
      {
        label: "Clinical work",
        requiredFeature: "module.clinical",
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
            href: "/admin/fit-sessions",
            label: "Fit review",
            icon: ClipboardCheck,
            matchPrefix: "/admin/fit-sessions",
            requiredPermission: "clinical.read",
            hint: "Fittings the engine declined to be confident about — approve, override, or send back for a rescan",
          },
          {
            href: "/admin/provider-referrals",
            label: "Referrals",
            icon: Inbox,
            matchPrefix: "/admin/provider-referrals",
            requiredPermission: "clinical.read",
            hint: "Patients sent to you by referring clinicians, fitting and mask approval already done",
          },
          {
            href: "/admin/fitter/catalog",
            label: "Mask catalog",
            icon: Library,
            matchPrefix: "/admin/fitter/catalog",
            requiredPermission: "clinical.read",
            hint: "Mask intelligence: interface type, therapy compatibility, magnets, per-size measurement ranges, and the clinical sign-off queue",
          },
          {
            href: "/admin/fitter/formulary",
            label: "Formulary",
            icon: ListFilter,
            matchPrefix: "/admin/fitter/formulary",
            requiredPermission: "clinical.read",
            hint: "What you dispense, by location, payer, contract, service line, and therapy mode",
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
        label: "Providers & recalls",
        requiredFeature: "module.providers",
        icon: HeartHandshake,
        hint: "Physician/NP registry and the equipment-recall registry",
        tabs: [
          {
            href: "/admin/providers",
            label: "Providers",
            icon: HeartHandshake,
            matchPrefix: "/admin/providers",
            hint: "Central physician/NP registry — NPPES-backed",
          },
          {
            href: "/admin/equipment-recalls",
            label: "Recalls",
            icon: ShieldCheck,
            matchPrefix: "/admin/equipment-recalls",
            hint: "Manufacturer recall registry + scan against dispensed serials",
          },
          {
            href: "/admin/asset-recovery",
            label: "Asset recovery",
            icon: Undo2,
            matchPrefix: "/admin/asset-recovery",
            requiredPermission: "cases.read",
            hint: "Recover machines from discontinued patients to refurbish + redeploy",
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
            href: "/admin/shop/orders",
            label: "Orders",
            icon: ShoppingBag,
            matchPrefix: "/admin/shop/orders",
            requiredPermission: "returns.manage",
            hint: "Paid storefront orders — look one up, set tracking, mark delivered, refund",
          },
          {
            href: "/admin/pennpaps/orders",
            label: "Fitter requests",
            icon: ScanFace,
            matchPrefix: "/admin/pennpaps/orders",
            hint: "AI mask-fitter order requests — read-only log of submitted fittings",
          },
          {
            href: "/admin/shipping",
            label: "Shipping labels",
            icon: TruckIcon,
            matchPrefix: "/admin/shipping",
            requiredPermission: "returns.manage",
            hint: "Print XPS shipping labels with the patient address merged in; tracking auto-fills",
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
        requiredFeature: "module.inventory",
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
        // Customer-facing shop surfaces plus the new-customer funnel —
        // one entry for "people who shop (or might)". The old separate
        // Leads section lives on as the three trailing tabs.
        label: "Storefront & leads",
        requiredFeature: "module.storefront",
        icon: ShoppingCart,
        hint: "Shop accounts, reviews, product Q&A, carts to recover, and new-customer leads",
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
          {
            href: "/admin/shop/insurance-leads",
            label: "Insurance Leads",
            icon: HeartHandshake,
            matchPrefix: "/admin/shop/insurance-leads",
            hint: "New benefit-verification requests",
          },
          {
            href: "/admin/fitter-invites",
            label: "Fitter Invites",
            icon: ScanFace,
            matchPrefix: "/admin/fitter-invites",
            hint: "Invite patients to the AI mask fitter + review results",
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
    // The single biggest lever on sidebar clutter: ~40 pages that a
    // cash-pay tenant will never open. Gated at the GROUP level so the
    // heading goes with it rather than leaving an orphaned entry. The
    // tenant's own plan & usage stays reachable — it is duplicated as an
    // ungated "Plan & billing" tab under System > Settings, so switching
    // this off can never strand someone away from their subscription.
    requiredFeature: "module.billing",
    items: [
      {
        // All the read-only money dashboards in one place: the AR
        // director hub up front, the per-payer trend dashboards (the
        // old Revenue analytics section) behind it as tabs.
        label: "Dashboards",
        icon: CircleDollarSign,
        hint: "Read-only money dashboards — AR hub, denial & DSO trends, collections forecast, payer profitability",
        tabs: [
          {
            href: "/admin/billing",
            label: "Billing Hub",
            icon: CircleDollarSign,
            matchPrefix: "/admin/billing",
            hint: "AR director dashboard — KPIs, money in flight, top payers",
          },
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
            href: "/admin/billing/disputes",
            label: "Chargeback disputes",
            icon: Gavel,
            matchPrefix: "/admin/billing/disputes",
            requiredPermission: "reports.read",
            hint: "Card chargebacks against storefront charges, ordered by evidence deadline",
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
        // Tabs follow the claim lifecycle: verify coverage → eligibility
        // worklists → prior auth → paperwork gates (CMN, bill hold) →
        // transmit → fix what bounced (AI queue) → appeal denials.
        label: "Worklists",
        icon: ListChecks,
        hint: "Daily billing worklists in claim order — verify insurance, eligibility, prior auths, CMN, bill hold, submit, denials",
        tabs: [
          {
            href: "/admin/billing/verify",
            label: "Verify insurance",
            icon: ShieldCheck,
            matchPrefix: "/admin/billing/verify",
            hint: "Run an on-demand insurance verification (270/271) for any patient — or a quick check with no patient record",
          },
          {
            href: "/admin/billing/insurance-discovery",
            label: "Insurance discovery",
            icon: ScanSearch,
            matchPrefix: "/admin/billing/insurance-discovery",
            hint: "Search the payer network from demographics to find active coverage when insurance is unknown or a coverage came back inactive (add-on)",
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
            href: "/admin/billing/prior-auths",
            label: "Prior auths",
            icon: ShieldAlert,
            matchPrefix: "/admin/billing/prior-auths",
            hint: "Missed / at-risk SLA + auths expiring soon + drafts to submit",
          },
          {
            href: "/admin/billing/cmn",
            label: "CMN / DIF worklist",
            icon: FileCheck2,
            matchPrefix: "/admin/billing/cmn",
            requiredPermission: "reports.read",
            hint: "Draft Certificates of Medical Necessity awaiting completion",
          },
          {
            href: "/admin/billing/bill-hold",
            label: "Bill hold",
            icon: FileLock2,
            matchPrefix: "/admin/billing/bill-hold",
            requiredPermission: "reports.read",
            hint: "Claims held from billing until their signed paperwork is back",
          },
          {
            href: "/admin/billing/adr",
            label: "ADR / audit response",
            icon: ShieldAlert,
            matchPrefix: "/admin/billing/adr",
            requiredPermission: "reports.read",
            hint: "Payer/contractor documentation requests by deadline; build the audit-response packet",
          },
          {
            href: "/admin/billing/audit-readiness",
            label: "Audit readiness",
            icon: ShieldAlert,
            matchPrefix: "/admin/billing/audit-readiness",
            requiredPermission: "reports.read",
            hint: "Billed-claim patients missing audit-critical documents — chase paperwork before an audit",
          },
          {
            href: "/admin/billing/collections",
            label: "Collections",
            icon: CircleDollarSign,
            matchPrefix: "/admin/billing/collections",
            requiredPermission: "reports.read",
            hint: "Patient balances on the dunning ladder — pause, resolve, or cancel a run",
          },
          {
            href: "/admin/billing/notes",
            label: "Billing notes",
            icon: StickyNote,
            matchPrefix: "/admin/billing/notes",
            hint: "Shared notes log for the billing team — claims, collections, payers, and account context",
          },
          {
            href: "/admin/billing/auto-submit",
            label: "Auto-submit",
            icon: Send,
            matchPrefix: "/admin/billing/auto-submit",
            requiredPermission: "billing.manage",
            hint: "Claims ready to transmit — preflight-clean + active eligibility. Approve a batch or let the cron send them.",
          },
          {
            href: "/admin/billing/ai-queue",
            label: "AI queue",
            icon: Bot,
            matchPrefix: "/admin/billing/ai-queue",
            hint: "Scrubber-blocked + denial-analyzer worklist with auto-resubmit",
          },
          {
            href: "/admin/billing/denials-worklist",
            label: "Denials worklist",
            icon: Gavel,
            matchPrefix: "/admin/billing/denials-worklist",
            requiredPermission: "reports.read",
            hint: "Open denials ranked by recoverable $ × win-probability",
          },
        ],
      },
      {
        // Split out of the old "A/R & revenue" grab-bag: the actionable
        // money-collection worklists (work these to get paid). The pure
        // revenue dashboards live under "Dashboards" above, so this
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
        label: "Tools",
        icon: SlidersHorizontal,
        hint: "Clearinghouse submissions, ERA posting, manual claim entry, and billing configuration",
        tabs: [
          {
            href: "/admin/billing/era",
            label: "ERA files",
            icon: Wallet,
            matchPrefix: "/admin/billing/era",
            hint: "Upload an 835 to auto-post payer adjudications",
          },
          {
            href: "/admin/billing/office-ally",
            label: "Office Ally",
            icon: Send,
            matchPrefix: "/admin/billing/office-ally",
            requiredPermission: "billing.manage",
            hint: "Office Ally clearinghouse — 837P submissions, acknowledgements, and transmission status",
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
          {
            href: "/admin/billing/package",
            label: "Package & usage",
            icon: CircleDollarSign,
            matchPrefix: "/admin/billing/package",
            hint: "Current CareMetric package, add-ons, and monthly usage",
          },
        ],
      },
    ],
  },
  {
    label: "Analytics & Reports",
    requiredFeature: "module.analytics",
    items: [
      {
        label: "Reports",
        icon: BarChart3,
        href: "/admin/reports",
        matchPrefix: "/admin/reports",
        hint: "CSV, PDF, and QuickBooks (IIF / QBO) exports for ops and finance",
      },
      {
        label: "Audit Trail",
        icon: ShieldCheck,
        href: "/admin/analytics/audit-trail",
        matchPrefix: "/admin/analytics/audit-trail",
        // audit.read keeps it out of the CSR/clinician sidebar; the page
        // itself enforces full-admin only (matching the server's
        // requireAdminOnly gate).
        requiredPermission: "audit.read",
        hint: "Who accessed which patient's info, when — filter by employee, patient, and time frame (admins only)",
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
            href: "/admin/analytics/acquisition-funnel",
            label: "Acquisition funnel",
            icon: ListFilter,
            matchPrefix: "/admin/analytics/acquisition-funnel",
            requiredPermission: "reports.read",
            hint: "Where anonymous visitors drop out of the fitter and shop checkout flows",
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
            href: "/admin/analytics/channel-engagement",
            label: "Channel engagement",
            icon: Activity,
            matchPrefix: "/admin/analytics/channel-engagement",
            requiredPermission: "reports.read",
            hint: "Automation scoreboard — SMS/email/chat replies + phone answered/missed, paired with purchases",
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
            href: "/admin/reorder-reminders",
            label: "Reorder Reminders",
            icon: BellRing,
            matchPrefix: "/admin/reorder-reminders",
            requiredPermission: "reports.read",
            hint: "Reorder reminder funnel — due → reminded → confirmed → shipped, with per-channel conversion",
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
            hint: "Storefront traffic & revenue",
          },
        ],
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Support",
        requiredFeature: "module.support",
        icon: LifeBuoy,
        href: "/admin/support",
        matchPrefix: "/admin/support",
        hint: "File a support request — our AI assistant answers how-to questions instantly, and a person handles the rest",
      },
      {
        label: "Help & Resources",
        icon: BookOpenCheck,
        href: "/admin/resources",
        matchPrefix: "/admin/resources",
        hint: "Downloadable setup guides and documentation for your team",
      },
      {
        label: "Automation",
        requiredFeature: "module.automation",
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
        hint: "Background job health, message delivery, integrations, webhooks",
        tabs: [
          {
            href: "/admin/operations",
            label: "Operations",
            icon: Activity,
            matchPrefix: "/admin/operations",
            hint: "Health of background jobs and pipelines",
          },
          {
            href: "/admin/outbound-messages",
            label: "Outbound Messages",
            icon: Send,
            matchPrefix: "/admin/outbound-messages",
            requiredPermission: "admin.tools.manage",
            hint: "Every outbound SMS and email with its delivery result (sent / delivered / failed)",
          },
          {
            href: "/admin/delivery-failures",
            label: "Delivery Failures",
            icon: TruckIcon,
            matchPrefix: "/admin/delivery-failures",
            hint: "Bounced messages and shipping exceptions",
          },
          {
            href: "/admin/integrations",
            requiredFeature: "module.integrations",
            label: "Integrations",
            icon: Plug,
            matchPrefix: "/admin/integrations",
            // GET /admin/integrations-status requires admin.tools.manage;
            // gate the nav entry to match so a plain CSR doesn't open a page
            // that 403s on load.
            requiredPermission: "admin.tools.manage",
            hint: "Therapy-cloud vendor connections and nightly sync status",
          },
          {
            href: "/admin/pacware",
            requiredFeature: "module.integrations",
            label: "PacWare",
            icon: Boxes,
            matchPrefix: "/admin/pacware",
            requiredPermission: "admin.tools.manage",
            badgeKey: "pacwareReadyToSync",
            hint: "PacWare (DME billing) CSV import & export",
          },
          {
            href: "/admin/webhook-deliveries",
            requiredFeature: "module.integrations",
            label: "Webhook Deliveries",
            icon: Webhook,
            matchPrefix: "/admin/webhook-deliveries",
            requiredPermission: "admin.tools.manage",
            hint: "Outbound event deliveries to partner endpoints — re-queue failed/exhausted sends",
          },
        ],
      },
      {
        // Day-to-day practice settings — the things an admin touches in
        // a normal month. The launch checklist, feature switches, and
        // super-admin credential surfaces live under "Setup & advanced".
        label: "Settings",
        icon: Settings,
        hint: "Practice settings, closures, team accounts, and your own security",
        tabs: [
          {
            href: "/admin/setup",
            label: "Set up your workspace",
            icon: ListChecks,
            matchPrefix: "/admin/setup",
            hint: "Guided checklist: brand, domain, phone/SMS/fax numbers, email sender, and payments",
          },
          {
            href: "/admin/settings",
            label: "Settings",
            icon: Settings,
            matchPrefix: "/admin/settings",
            hint: "Toggle the client-only demo sandbox",
          },
          {
            href: "/admin/company-information",
            label: "Company information",
            icon: Building2,
            matchPrefix: "/admin/company-information",
            // GET /admin/dme-organization requires admin.tools.manage; gate
            // the nav entry to match so a plain CSR doesn't open a page that
            // 403s on load.
            requiredPermission: "admin.tools.manage",
            hint: "Company name, addresses, and contact info used on documents, the storefront, and messages",
          },
          {
            href: "/admin/storefront-branding",
            label: "Storefront branding",
            icon: Store,
            matchPrefix: "/admin/storefront-branding",
            hint: "Your storefront name, tagline, and logo — plus wiring up your own custom domain",
          },
          {
            href: "/admin/phone-settings",
            label: "Phone & SMS",
            icon: PhoneCall,
            matchPrefix: "/admin/phone-settings",
            hint: "Your own voice + SMS numbers for the voice agent and resupply texting",
          },
          {
            href: "/admin/fax-settings",
            label: "Fax number",
            icon: Printer,
            matchPrefix: "/admin/fax-settings",
            hint: "Your practice's own fax number for inbound and outbound faxes",
          },
          {
            href: "/admin/email-settings",
            label: "Email From address",
            icon: Mail,
            matchPrefix: "/admin/email-settings",
            hint: "Send patient email from your own address (with SendGrid domain-auth status)",
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
            requiredPermission: "admin.tools.manage",
            hint: "Manage admin & agent accounts",
          },
          {
            href: "/admin/locations",
            label: "Locations",
            icon: MapPin,
            matchPrefix: "/admin/locations",
            hint: "Business branches that service patients (assign patients from their detail page)",
            // Only shown when the multi-branch feature is enabled. The
            // AppShell injects this pseudo-permission token into the nav
            // permission set when /me reports multiLocationEnabled — see
            // navPermissions below. (Not a server permission; purely a
            // nav-visibility key, like the rest of requiredPermission.)
            requiredPermission: MULTI_LOCATION_NAV_TOKEN,
          },
          {
            href: "/admin/security",
            label: "Account security",
            icon: ShieldCheck,
            matchPrefix: "/admin/security",
            hint: "Manage your own MFA / authenticator-app enrollment",
          },
          {
            // Deliberately duplicated from Billing > Tools. YOUR
            // subscription is a settings concern, not a claims-billing
            // one, and this copy carries no `requiredFeature` — so a
            // tenant that switches the whole Billing module off can
            // still reach the page where they change their plan. Without
            // it, "we don't bill insurance" would also mean "I can't
            // find where to pay you". Active-tab resolution is
            // deterministic on a tie (NAV_GROUPS order), so the Billing
            // copy stays the highlighted one while that group is on.
            href: "/admin/billing/package",
            label: "Plan & billing",
            icon: CircleDollarSign,
            matchPrefix: "/admin/billing/package",
            hint: "Your CareMetric package, add-ons, and monthly usage",
          },
        ],
      },
      {
        // Set-and-forget surfaces: enter your own integration
        // credentials, switch features on, then rehearse the bots. The
        // deployment launch checklist, platform packages/pricing, and
        // shared infrastructure all live on the platform super-admin
        // console — they're global, not per-tenant.
        label: "Setup & advanced",
        icon: SlidersHorizontal,
        hint: "Your integration credentials, feature switches, and bot rehearsal",
        tabs: [
          {
            href: "/admin/system/configuration",
            label: "Configuration",
            icon: SlidersHorizontal,
            matchPrefix: "/admin/system/configuration",
            requiredPermission: "system.config.manage",
            hint: "Your branding and your own integration accounts (therapy-cloud, clearinghouse)",
          },
          {
            href: "/admin/control-center",
            label: "Control Center",
            icon: ToggleLeft,
            matchPrefix: "/admin/control-center",
            requiredPermission: "admin.tools.manage",
            hint: "On/off switches for major features (voice, SMS, campaigns, AI billing, …)",
          },
          {
            href: "/admin/bot-playground",
            label: "Bot playground",
            icon: FlaskConical,
            matchPrefix: "/admin/bot-playground",
            requiredPermission: "admin.tools.manage",
            hint: "Rehearse the chat & voice bots against scripted situations (synthetic data, simulated tools) to tune their prompts",
          },
        ],
      },
    ],
  },
];

// Standalone "Virtual Mask Fitter" plan (migration 0419). A tenant whose
// /me reports productScope === "mask_fitter" subscribed to JUST the AI mask
// fitter, so the console collapses to the fitter worklist + the account
// essentials they need to run it (brand the link, manage their plan, basic
// settings). Every operational module is hidden — and the backend
// independently 403s them, so this is purely the matching UX, not the
// security boundary. The SPA route guard (useMaskFitterRouteGuard) redirects
// any URL outside these prefixes back to the fitter worklist.
const MASK_FITTER_NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Mask Fitter",
    items: [
      {
        label: "Fitter Invites",
        icon: ScanFace,
        href: "/admin/fitter-invites",
        matchPrefix: "/admin/fitter-invites",
        hint: "Invite patients to the AI mask fitter + review the mask & size that come back",
      },
      {
        label: "Fitter Prospects",
        icon: UsersRound,
        href: "/admin/fitter-leads",
        matchPrefix: "/admin/fitter-leads",
        hint: "Fitter funnel + supply-campaign conversion",
      },
      {
        label: "Fit Review",
        icon: ClipboardCheck,
        href: "/admin/fit-sessions",
        matchPrefix: "/admin/fit-sessions",
        hint: "Fittings that need a clinician's eye before they go out",
      },
      {
        label: "Referrals",
        icon: Inbox,
        href: "/admin/provider-referrals",
        matchPrefix: "/admin/provider-referrals",
        hint: "Patients referred to you, with their fitting already done",
      },
      {
        label: "Mask Catalog",
        icon: Library,
        href: "/admin/fitter/catalog",
        matchPrefix: "/admin/fitter/catalog",
        hint: "The masks you fit against — and the clinical sign-off queue for estimated sizing",
      },
      {
        label: "Formulary",
        icon: ListFilter,
        href: "/admin/fitter/formulary",
        matchPrefix: "/admin/fitter/formulary",
        hint: "Which of those masks you actually dispense",
      },
    ],
  },
  {
    label: "Account",
    items: [
      {
        label: "Storefront branding",
        icon: Store,
        href: "/admin/storefront-branding",
        matchPrefix: "/admin/storefront-branding",
        hint: "Brand the fitting link — your name, logo, and custom domain",
      },
      {
        // The tenant SUBSCRIPTION page — NOT /account/billing, which is the
        // patient-facing storefront billing portal (gated by a shop-customer
        // session a tenant admin doesn't have).
        label: "Billing",
        icon: Wallet,
        href: "/admin/billing/package",
        matchPrefix: "/admin/billing/package",
        hint: "Manage your Virtual Mask Fitter subscription and usage",
      },
      {
        label: "Settings",
        icon: Settings,
        href: "/admin/settings",
        matchPrefix: "/admin/settings",
        hint: "Workspace settings",
      },
      {
        // Account security (MFA enrollment). The MfaEnforcementBanner also
        // links here, so it must be reachable under the fitter scope.
        label: "Account security",
        icon: ShieldCheck,
        href: "/admin/security",
        matchPrefix: "/admin/security",
        hint: "Manage your own MFA / authenticator-app enrollment",
      },
    ],
  },
];

/** SPA route prefixes a mask_fitter-scoped tenant may visit. Mirrors the
 *  server allowlist in lib/product-scope.ts; the server is the real gate.
 *  Only `/admin/*` routes are guarded (the guard early-returns otherwise),
 *  so account-essential pages reached from Settings (team, MFA) are listed
 *  here too. The billing entry is the subscription page specifically — the
 *  operational claims worklists under /admin/billing/ stay blocked. */
const MASK_FITTER_ALLOWED_ROUTE_PREFIXES: readonly string[] = [
  "/admin/fitter-invites",
  "/admin/fitter-leads",
  "/admin/storefront-branding",
  "/admin/settings",
  "/admin/security",
  "/admin/billing/package",
  "/admin/team",
];

// Payment wall (migration 0427). A tenant whose /me reports
// productScope === "locked" signed up but hasn't paid their first invoice yet,
// so the console collapses to JUST the billing page (where they pick a plan +
// pay) and account security. Everything else is hidden — and the backend
// independently 403s it. The route guard bounces any other URL to the billing
// page; the Stripe invoice.paid webhook clears the lock.
const LOCKED_NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Get started",
    items: [
      {
        label: "Billing & payment",
        icon: Wallet,
        href: "/admin/billing/package",
        matchPrefix: "/admin/billing/package",
        hint: "Choose your plan and complete payment to unlock your console",
      },
      {
        label: "Account security",
        icon: ShieldCheck,
        href: "/admin/security",
        matchPrefix: "/admin/security",
        hint: "Manage your own MFA / authenticator-app enrollment",
      },
    ],
  },
];

/** SPA route prefixes a locked (unpaid) tenant may visit. Mirrors the server
 *  allowlist in lib/product-scope.ts (isLockedAllowedPath); the server is the
 *  real gate. Tighter than the fitter list — billing + account only. */
const LOCKED_ALLOWED_ROUTE_PREFIXES: readonly string[] = [
  "/admin/billing/package",
  "/admin/security",
  "/admin/agreements",
];

/** The nav a tenant sees for its plan scope: the pay-to-unlock nav for an
 *  unpaid tenant, the curated fitter-only nav for the standalone Virtual Mask
 *  Fitter plan, else the full console nav. */
function navGroupsForScope(
  productScope: string | undefined,
): ReadonlyArray<NavGroup> {
  if (productScope === "locked") return LOCKED_NAV_GROUPS;
  return productScope === "mask_fitter" ? MASK_FITTER_NAV_GROUPS : NAV_GROUPS;
}

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

// linkMatchesLocation, flattenTargets, pickActiveTarget, pickActiveHref,
// findGroupForActiveHref, visibleTabs, sectionLandingHref, sectionVisible,
// and sectionBadgeCount now live in ./nav-traversal (imported above) and
// are unit-tested in nav-traversal.test.ts.

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
  navGroups,
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
  /** The nav model to render — already narrowed by the parent for the
   *  tenant's product scope AND for the app modules it has switched off,
   *  so both the sidebar and the sub-nav draw from one filtered source. */
  navGroups: ReadonlyArray<NavGroup>;
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
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((link) => sectionVisible(link, permissions)),
    }))
    .filter((group) => group.items.length > 0);

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
  navGroups,
}: {
  location: string;
  isAdminConfirmed: boolean;
  permissions: ReadonlySet<string>;
  /** The same filtered nav the sidebar renders, so a tab bar never offers
   *  a page the tenant's product scope or app modules have removed. */
  navGroups: ReadonlyArray<NavGroup>;
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

  const active = pickActiveTarget(location, navGroups);
  if (!active?.section?.tabs) return null;
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
          //
          // Navigate ONLY on success. A failed /sign-out (5xx / network
          // blip) leaves the pf_session cookie valid — navigating to
          // /admin/sign-in anyway would show a signed-out screen while the
          // admin is still authenticated (the next /me succeeds), a false
          // sign-out that's especially dangerous on a shared workstation
          // since admin tokens unlock PHI. On failure, stay put and surface
          // a retry prompt. The shim re-throws precisely so we can do this.
          void signOut().then(
            () => {
              setShellLocation("/admin/sign-in");
            },
            (err: unknown) => {
              console.error("admin sign-out failed", err);
              toast({
                variant: "destructive",
                title: "Sign-out failed",
                description:
                  "You're still signed in. Check your connection and try again.",
              });
            },
          );
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
/**
 * Payment wall banner (migration 0427). Shown across the admin console when a
 * tenant's /me reports productScope === "locked" — they signed up but haven't
 * paid their first invoice. On the billing page it's a calmer inline notice
 * (they're already where they need to be); elsewhere it's a prominent strip
 * with a "Go to billing" control. The route guard also bounces them to billing,
 * so this is mostly the explanation. The Stripe invoice.paid webhook clears the
 * lock, after which /me reports their real scope and this disappears.
 */
function PaymentRequiredBanner() {
  const { data: adminMe } = useGetAdminMe();
  const [location] = useLocation();
  // "Pay now" — start a hosted Stripe Checkout session and redirect. On a
  // successful payment Stripe's webhook clears the lock and /me reports the
  // tenant's real scope, so this banner disappears.
  const [payErr, setPayErr] = useState<string | null>(null);
  const checkout = useMutation({
    mutationFn: () => startTenantCheckout(),
    onSuccess: ({ url }) => {
      if (url) window.location.assign(url);
    },
    onError: () =>
      setPayErr(
        "We couldn't start checkout just now. Please try again in a moment.",
      ),
  });
  if (adminMe?.productScope !== "locked") return null;

  const payNow = (
    <button
      type="button"
      onClick={() => {
        setPayErr(null);
        checkout.mutate();
      }}
      disabled={checkout.isPending}
      className="rounded bg-amber-900 text-white px-3 py-1.5 text-xs font-semibold whitespace-nowrap disabled:opacity-60"
    >
      {checkout.isPending ? "Starting checkout…" : "Pay now & unlock"}
    </button>
  );

  if (location.startsWith("/admin/billing/package")) {
    return (
      <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start justify-between gap-3">
        <div>
          Choose a plan below, or pay for your current plan now to unlock the
          rest of your console.
          {payErr ? (
            <span className="block mt-1 text-rose-700">{payErr}</span>
          ) : null}
        </div>
        {payNow}
      </div>
    );
  }
  return (
    <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 flex items-start justify-between gap-3">
      <div>
        <strong>Your account is pending payment.</strong> Pay now to unlock the
        rest of your console, or visit billing to change your plan first.
        {payErr ? (
          <span className="block mt-1 text-rose-700">{payErr}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/admin/billing/package"
          className="rounded border border-amber-900 text-amber-900 px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
        >
          Billing
        </Link>
        {payNow}
      </div>
    </div>
  );
}

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

/**
 * Persistent banner shown across the admin console when a PLATFORM admin
 * is acting AS a tenant (G4 impersonation). It's a high-contrast warning
 * strip with a "Stop impersonating" control that revokes the act-as-tenant
 * session. Rendered only when `/me` reports `impersonation: true`.
 *
 * Stop semantics (v1): starting impersonation OVERWRITES the single
 * pf_session cookie with the act-as session (the #999 design), so a
 * successful stop clears that cookie and signs the operator out. We send
 * them to /admin/sign-in — re-signing in returns them to the platform
 * console. (A future enhancement could give impersonation its own cookie
 * so the platform session survives; tracked as a #999 follow-up.)
 */
function ImpersonationBanner() {
  const stop = useStopImpersonation();
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 px-4 py-2 text-sm font-semibold text-white"
      style={{ backgroundColor: "hsl(354 70% 42%)" }}
    >
      <span className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        You are operating this tenant as a platform admin (impersonation).
        Stopping signs you out — sign back in to return to the platform console.
        {stop.isError ? " Couldn't stop — try again." : null}
      </span>
      <button
        type="button"
        disabled={stop.isPending}
        onClick={() => {
          stop.mutate(undefined, {
            // Navigate away ONLY on success. The stop endpoint clears the
            // session cookie server-side and returns 200 even on the
            // already-stopped no-op path, so a failure here means the
            // request never landed and the operator is STILL impersonating
            // — staying put (and surfacing the error) keeps the banner
            // honest. On success the cookie is gone, so route to sign-in.
            onSuccess: () => window.location.assign("/admin/sign-in"),
          });
        }}
        className="inline-flex items-center rounded-md border border-white/70 px-3 py-1 text-xs font-semibold hover:bg-white/10 disabled:opacity-60"
      >
        {stop.isPending ? "Stopping…" : "Stop impersonating"}
      </button>
    </div>
  );
}

/**
 * Shown in place of a page whose app module the tenant has switched off.
 *
 * Deliberately NOT a redirect. A silent bounce to the dashboard is
 * indistinguishable from a broken link, and the person hitting it is
 * usually the person who can fix it — so the notice names the module and,
 * for an operator who can manage it, links straight to the switch.
 */
function FeatureTurnedOffNotice({
  featureKey,
  canManage,
}: {
  featureKey: string;
  canManage: boolean;
}) {
  return (
    <div
      className="max-w-xl rounded-lg border border-slate-200 bg-white p-6"
      data-testid="admin-feature-turned-off"
    >
      <div className="flex items-start gap-3">
        <EyeOff
          className="h-5 w-5 mt-0.5 shrink-0 text-slate-400"
          aria-hidden="true"
        />
        <div className="space-y-2">
          <h1 className="text-base font-semibold text-slate-900">
            {appModuleLabel(featureKey)} is turned off
          </h1>
          <p className="text-sm text-slate-600">
            This part of the app is switched off for your company, so it has
            been removed from the sidebar. Nothing was deleted — turning it back
            on restores these pages and everything in them.
          </p>
          {canManage ? (
            <Link
              href="/admin/control-center"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-[hsl(var(--penn-navy))] hover:underline"
              data-testid="admin-feature-turned-off-manage"
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              Turn it back on in Control Center
            </Link>
          ) : (
            <p className="text-sm text-slate-500">
              Ask a super admin if you need it switched back on.
            </p>
          )}
        </div>
      </div>
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
  // The multi-branch feature toggle (Control Center). When on, inject the
  // nav-visibility token so the Locations entry appears; when off it's
  // hidden along with the rest of the branch UI.
  const { data: adminMe } = useGetAdminMe();
  const navPermissions = useMemo(() => {
    const set = new Set(adminPermissions ?? []);
    if (adminMe?.multiLocationEnabled) set.add(MULTI_LOCATION_NAV_TOKEN);
    return set;
  }, [adminPermissions, adminMe?.multiLocationEnabled]);
  // Platform product scope (migration 0419). "mask_fitter" collapses the
  // console to the fitter-only nav and guards the routes.
  const productScope = adminMe?.productScope;
  const [location, setLocation] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Route guard for scoped-down tenants: a tenant that lands on (or deep-links
  // to) a console route outside its allowlist is bounced to its home page. The
  // server independently 403s those routes — this just keeps the SPA from
  // rendering a page that would only show errors. No-op for "full" scope
  // (every normal tenant). `/account/*` (e.g. billing) is a separate top-level
  // router, so it's never guarded here.
  useEffect(() => {
    if (!location.startsWith("/admin")) return;
    // Payment wall: an unpaid tenant can only reach billing + account security
    // until they pay; everything else bounces to the billing page.
    if (productScope === "locked") {
      const allowed = LOCKED_ALLOWED_ROUTE_PREFIXES.some((prefix) =>
        location.startsWith(prefix),
      );
      if (!allowed) setLocation("/admin/billing/package", { replace: true });
      return;
    }
    if (productScope === "mask_fitter") {
      const allowed = MASK_FITTER_ALLOWED_ROUTE_PREFIXES.some((prefix) =>
        location.startsWith(prefix),
      );
      if (!allowed) setLocation("/admin/fitter-invites", { replace: true });
    }
  }, [productScope, location, setLocation]);

  // ── Shared sidebar nav state ──────────────────────────────────────────────
  // Both the desktop sidebar and the mobile drawer render SidebarNavBody.
  // State lives here (not inside SidebarNavBody) so there is only one copy
  // and only one localStorage writer — preventing the CSS-hidden instance
  // from clobbering toggle changes made by the visible one.

  // App modules the tenant has switched off (migration 0488). Empty while
  // /me is in flight and empty when the server can't read the flag table,
  // so the console renders whole rather than empty in both cases — the
  // safe direction for a purely presentational signal.
  const disabledFeatures = useMemo(
    () => new Set(adminMe?.disabledFeatures ?? []),
    [adminMe?.disabledFeatures],
  );
  const fullNavGroups = navGroupsForScope(productScope);
  const scopedNavGroups = useMemo(
    () => filterNavGroupsByFeature(fullNavGroups, disabledFeatures),
    [fullNavGroups, disabledFeatures],
  );
  // A bookmark or emailed link into a part of the app that has since been
  // switched off. We render an explanation in place of the page rather
  // than redirecting: bouncing someone to the dashboard with no reason
  // looks like the link is broken, and the fix (turn the module back on)
  // is one they can actually take.
  const hiddenByFeature = useMemo(
    () => featureHidingLocation(location, fullNavGroups, disabledFeatures),
    [location, fullNavGroups, disabledFeatures],
  );
  const activeGroup = findGroupForActiveHref(
    scopedNavGroups,
    pickActiveHref(location, scopedNavGroups),
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
        {adminMe?.impersonation ? <ImpersonationBanner /> : null}
        <BrandHeader
          rightSlot={
            adminEmail ? (
              <div className="flex items-center gap-3">
                {/* GlobalLookup searches patients/orders — irrelevant to a
                    fitter-only or unpaid tenant, and its endpoint isn't in
                    their scope. */}
                {productScope === "mask_fitter" ||
                productScope === "locked" ? null : (
                  <GlobalLookup />
                )}
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
                    navGroups={scopedNavGroups}
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
                navGroups={scopedNavGroups}
              />
            </nav>
          </aside>
          <main className="flex-1 p-4 sm:p-6 overflow-x-hidden min-w-0">
            <PaymentRequiredBanner />
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
                navGroups={scopedNavGroups}
              />
            ) : null}
            {hiddenByFeature ? (
              <FeatureTurnedOffNotice
                featureKey={hiddenByFeature}
                canManage={navPermissions.has("admin.tools.manage")}
              />
            ) : (
              children
            )}
          </main>
        </div>
        <BrandFooter />
        {/*
        PennPilot — the in-app tech-support / program-manager assistant.
        Floating launcher, available on every admin page. Only rendered
        for a confirmed admin session (adminEmail set) so it never shows
        during the signed-out access-check window. Server-side it's gated
        by requireAdmin + the `admin.assistant` feature flag, so a missing
        AI key or a disabled flag degrades it gracefully.
      */}
        {/* The admin assistant (PennPilot) is a full-console helper; hide it
            for fitter-only and unpaid tenants (its chat endpoint isn't in
            their scope). */}
        {adminEmail &&
        productScope !== "mask_fitter" &&
        productScope !== "locked" ? (
          <AdminAssistantWidget />
        ) : null}
      </div>
    </RoleProvider>
  );
}

// Demo fixtures for the super-admin PLATFORM console (`/platform/*`).
//
// The platform console is the tier ABOVE a tenant admin: it operates the
// platform itself (tenant directory + lifecycle, cross-tenant analytics
// and margin, global infra credentials, the operator roster, the support
// queue, outreach campaigns, vendor cost rates). Server-side every one of
// those routes sits behind `requirePlatformAdmin`.
//
// Previously the demo sandbox seeded only `/platform/me` and four billing
// reads, so ten of the console's twelve pages rendered their empty state
// and none of the super-admin ACTIONS could be exercised. This module
// seeds the whole surface, and keeps a session-scoped mutable store so the
// write paths actually stick: create/suspend/reactivate a tenant, toggle a
// feature flag, grant/revoke an operator, edit a config value, reply to a
// ticket, add a contact, start a campaign — each one updates the store and
// the next read reflects it, exactly like the live console.
//
// Everything here is fictional. No real tenant, operator, or PHI appears —
// tenant metadata is brand/slug/domain only, matching the real routes'
// "no patient data crosses this surface" posture.
//
// Naming: the platform is CareMetric Breathe (`cmbreathe.com`); the demo
// tenants are invented DMEs, none of them the Penn Home Medical Supply
// tenant.

import { daysAgo, hoursAgo, NOW_ISO } from "./dates";

/** The signed-in demo super-admin (matches `demoPlatformMe`). */
export const DEMO_PLATFORM_OPERATOR = "demo.admin@cmbreathe.example";

// ── Deterministic pseudo-random series ──────────────────────────────
// Sparklines need to look organic but must not change between renders
// (a re-fetch that reshuffles the chart looks broken). This is a plain
// integer hash — deliberately NOT Math.random, both for stability and
// because the repo routes id generation through the Web Crypto CSPRNG to
// keep CodeQL's js/insecure-randomness rule clean. This value is only
// ever a chart height, never an id or a token.
function wobble(seed: string, index: number): number {
  let h = 2166136261 ^ index;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Fold to a 0..1 fraction.
  return ((h >>> 0) % 1000) / 1000;
}

/** A `days`-long series that trends toward `avg` with organic variation. */
function series(
  seed: string,
  days: number,
  avg: number,
  spread = 0.6,
): number[] {
  return Array.from({ length: days }, (_, i) => {
    const drift = 0.75 + (0.5 * i) / Math.max(1, days - 1); // gentle growth
    const noise = 1 + (wobble(seed, i) - 0.5) * spread * 2;
    return Math.max(0, Math.round(avg * drift * noise));
  });
}

/** Ordered UTC `YYYY-MM-DD` labels ending today. */
function dayKeys(days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Percent change of the latter half vs the former, or null with no base. */
function delta(values: number[]): number | null {
  const half = Math.floor(values.length / 2);
  if (half === 0) return null;
  const prior = sum(values.slice(0, half));
  const current = sum(values.slice(half));
  if (prior === 0) return null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

// ── Types (mirrors of the client-side response types) ───────────────
// Structural mirrors of `lib/api-client-react/src/admin/platform.ts` and
// `src/lib/admin/platform-*-api.ts`. Declared locally so the fixture
// module stays dependency-light (the demo chunk is lazy-loaded), and
// typed so a shape drift in the client trips `pnpm typecheck` here.

export interface DemoTenant {
  id: string;
  slug: string;
  name: string | null;
  storefrontName: string | null;
  status: string;
  customDomain: string | null;
  customDomainStatus: string | null;
  createdAt: string;
  fromEmail: string | null;
  fromName: string | null;
  updatedAt: string | null;
  /** Demo-only shaping data — never returned raw to the console. */
  seed: {
    patients: number;
    orders: number;
    conversations: number;
    aov: number;
  };
}

interface DemoFlag {
  key: string;
  enabled: boolean;
  description: string;
  category: string;
  manageable: boolean;
  updatedByEmail: string | null;
  updatedAt: string;
}

interface DemoFlagActivity {
  occurredAt: string;
  operatorEmail: string | null;
  key: string;
  from: boolean;
  to: boolean;
}

interface DemoTenantAdmin {
  id: string;
  email: string | null;
  role: string;
  status: string;
  displayName: string | null;
  lastLoginAt: string | null;
  invitedAt: string | null;
}

interface DemoOperator {
  authUserId: string;
  email: string | null;
  displayName: string | null;
  status: string | null;
  grantedByEmail: string | null;
  createdAt: string;
}

interface DemoContact {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  tags: string[];
  notes: string | null;
  unsubscribed: boolean;
  unsubscribed_at: string | null;
  source: "manual" | "import";
  created_at: string;
  updated_at: string;
}

interface DemoCampaignRecipient {
  id: string;
  recipientKind: "tenant" | "contact" | "manual";
  recipientEmail: string;
  recipientName: string | null;
  status: string;
  suppressionReason: string | null;
}

interface DemoCampaign {
  id: string;
  name: string;
  subject: string;
  audienceKind:
    | "all_tenants"
    | "selected_tenants"
    | "all_contacts"
    | "contacts_by_tag"
    | "manual_list";
  status: "draft" | "sending" | "sent" | "paused" | "cancelled";
  totalRecipients: number;
  pendingRecipients: number;
  suppressedCount: number;
  sentCount: number;
  failedCount: number;
  throttlePerMinute: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  bodyText: string;
  bodyHtml: string | null;
  audiencePayload: unknown;
  recipients: DemoCampaignRecipient[];
}

type DemoTicketStatus =
  | "open"
  | "awaiting_tenant"
  | "awaiting_platform"
  | "resolved"
  | "closed";

interface DemoTicketMessage {
  id: string;
  authorRole: "tenant" | "bot" | "platform";
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

interface DemoTicket {
  id: string;
  subject: string;
  status: DemoTicketStatus;
  botAnswered: boolean;
  botConfidence: number | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  orgId: string;
  tenant: { slug: string; name: string | null } | null;
  messages: DemoTicketMessage[];
}

interface DemoCostRates {
  aiInputPer1mCents: number;
  aiOutputPer1mCents: number;
  outboundMessageCents: number;
  aiVoiceEventCents: number;
  faxEventCents: number;
}

interface DemoConfigValue {
  value: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
}

// ── Seed data ───────────────────────────────────────────────────────

/**
 * The canonical demo fleet. `demo-tenant-1` / `demo-tenant-2` keep the
 * ids, slugs and brand names already used by `platform-billing.ts` so the
 * Billing page and the Tenant directory describe the same fleet; two more
 * tenants exist to give the console a suspended row and a brand-new one.
 */
function seedTenants(): DemoTenant[] {
  return [
    {
      id: "demo-tenant-1",
      slug: "riverside-home-medical",
      name: "Riverside Home Medical",
      storefrontName: "RiversideCPAP",
      status: "active",
      customDomain: "shop.riversidehomemedical.example",
      customDomainStatus: "verified",
      createdAt: daysAgo(420),
      fromEmail: "care@riversidehomemedical.example",
      fromName: "Riverside Home Medical",
      updatedAt: daysAgo(3),
      seed: { patients: 312, orders: 96, conversations: 148, aov: 18400 },
    },
    {
      id: "demo-tenant-2",
      slug: "acme-sleep",
      name: "Acme Sleep DME",
      storefrontName: "AcmeSleep",
      status: "active",
      customDomain: null,
      customDomainStatus: null,
      createdAt: daysAgo(190),
      fromEmail: null,
      fromName: null,
      updatedAt: daysAgo(11),
      seed: { patients: 118, orders: 34, conversations: 52, aov: 15900 },
    },
    {
      id: "demo-tenant-3",
      slug: "north-star-respiratory",
      name: "North Star Respiratory",
      storefrontName: "NorthStar Sleep",
      status: "suspended",
      customDomain: "sleep.northstarresp.example",
      customDomainStatus: "verified",
      createdAt: daysAgo(275),
      fromEmail: "hello@northstarresp.example",
      fromName: "North Star Respiratory",
      updatedAt: daysAgo(28),
      seed: { patients: 64, orders: 6, conversations: 19, aov: 14200 },
    },
    {
      id: "demo-tenant-4",
      slug: "harbor-breathe",
      name: "Harbor Breathe Medical",
      storefrontName: "Harbor Breathe",
      status: "active",
      customDomain: null,
      customDomainStatus: "pending",
      createdAt: daysAgo(24),
      fromEmail: null,
      fromName: null,
      updatedAt: daysAgo(1),
      seed: { patients: 27, orders: 11, conversations: 16, aov: 17100 },
    },
  ];
}

/** A representative slice of the real `FEATURE_FLAG_KEYS` catalog. */
const FLAG_CATALOG: ReadonlyArray<{
  key: string;
  category: string;
  description: string;
  on: boolean;
}> = [
  // Messaging
  {
    key: "sms.reminders",
    category: "Messaging",
    description: "Send resupply reminders over SMS.",
    on: true,
  },
  {
    key: "email.reminders",
    category: "Messaging",
    description: "Send resupply reminders over email.",
    on: true,
  },
  {
    key: "email.auto_reply",
    category: "Messaging",
    description:
      "Let the assistant answer inbound patient email when confident.",
    on: false,
  },
  {
    key: "bulk_campaigns.send",
    category: "Messaging",
    description: "Allow bulk outbound campaigns.",
    on: true,
  },
  // AI surfaces
  {
    key: "storefront.chatbot",
    category: "AI assistants",
    description: "Storefront chat widget for shoppers.",
    on: true,
  },
  {
    key: "admin.assistant",
    category: "AI assistants",
    description: "In-app admin copilot for staff.",
    on: true,
  },
  {
    key: "voice.agent",
    category: "AI assistants",
    description: "Inbound/outbound AI voice agent.",
    on: true,
  },
  {
    key: "telehealth.video",
    category: "AI assistants",
    description: "Video visits with a respiratory therapist.",
    on: false,
  },
  // Storefront
  {
    key: "storefront.checkout",
    category: "Storefront",
    description: "RETIRED — patient cash-pay checkout was removed. Leave OFF.",
    on: false,
  },
  {
    key: "storefront.pickup",
    category: "Storefront",
    description: "Offer in-store pickup at checkout.",
    on: false,
  },
  {
    key: "storefront.reviews_collection",
    category: "Storefront",
    description: "Collect product reviews after delivery.",
    on: true,
  },
  {
    key: "storefront.nps",
    category: "Storefront",
    description: "Run the NPS survey after fulfilment.",
    on: true,
  },
  // Billing
  {
    key: "billing.auto_submit_claims",
    category: "Billing",
    description: "Submit clean claims to the clearinghouse automatically.",
    on: true,
  },
  {
    key: "billing.eligibility_precheck",
    category: "Billing",
    description: "Run an eligibility check before an order ships.",
    on: true,
  },
  {
    key: "ai_billing.suggestions",
    category: "Billing",
    description: "AI-suggested codes on the billing worklist.",
    on: false,
  },
  {
    key: "collections.dunning",
    category: "Billing",
    description: "Automated patient-balance dunning sequence.",
    on: false,
  },
  // Resupply engine
  {
    key: "resupply.entitlement_enforcement",
    category: "Resupply",
    description: "Enforce payer entitlement before a refill.",
    on: true,
  },
  {
    key: "resupply.auto_order_drafts",
    category: "Resupply",
    description: "Draft resupply orders automatically when due.",
    on: true,
  },
  {
    key: "resupply.refill_window_enforcement",
    category: "Resupply",
    description: "Block refills outside the payer window.",
    on: true,
  },
  // Operations
  {
    key: "support.tickets",
    category: "Operations",
    description: "In-app support tickets to the platform team.",
    on: true,
  },
  {
    key: "multi_location.enabled",
    category: "Operations",
    description: "Multiple physical locations for this tenant.",
    on: false,
  },
  {
    key: "provider.portal_enabled",
    category: "Operations",
    description: "Referring-provider portal access.",
    on: true,
  },
  {
    key: "slack.notifications",
    category: "Operations",
    description: "Post operational alerts to Slack.",
    on: false,
  },
  // A key this build can't toggle — exercises the `manageable: false`
  // deploy-drift path the console renders as a disabled switch.
  {
    key: "domains.tls_automation",
    category: "Operations",
    description: "Automatic TLS issuance for tenant custom domains.",
    on: false,
  },
];

function seedFlags(tenant: DemoTenant): DemoFlag[] {
  return FLAG_CATALOG.map((f, i) => ({
    key: f.key,
    // Vary per tenant so the console isn't four identical flag lists: the
    // suspended tenant has its outbound channels off, the new tenant has
    // only the basics on.
    enabled:
      tenant.status === "suspended"
        ? f.on && !f.key.startsWith("sms.") && !f.key.startsWith("voice.")
        : tenant.id === "demo-tenant-4"
          ? f.on && i < 12
          : f.on,
    description: f.description,
    category: f.category,
    manageable: f.key !== "domains.tls_automation",
    updatedByEmail: i % 5 === 0 ? DEMO_PLATFORM_OPERATOR : null,
    updatedAt: daysAgo(3 + i * 2),
  }));
}

function seedFlagActivity(tenant: DemoTenant): DemoFlagActivity[] {
  return [
    {
      occurredAt: hoursAgo(6),
      operatorEmail: DEMO_PLATFORM_OPERATOR,
      key: "storefront.chatbot",
      from: false,
      to: true,
    },
    {
      occurredAt: daysAgo(2),
      operatorEmail: DEMO_PLATFORM_OPERATOR,
      key: "billing.auto_submit_claims",
      from: false,
      to: true,
    },
    {
      occurredAt: daysAgo(9),
      operatorEmail: "ops@cmbreathe.example",
      key: "voice.agent",
      from: false,
      to: tenant.status !== "suspended",
    },
    {
      occurredAt: daysAgo(21),
      operatorEmail: DEMO_PLATFORM_OPERATOR,
      key: "email.auto_reply",
      from: true,
      to: false,
    },
  ];
}

function seedTenantAdmins(tenant: DemoTenant): DemoTenantAdmin[] {
  const domain = tenant.slug.replace(/-/g, "") + ".example";
  const base: DemoTenantAdmin[] = [
    {
      id: `${tenant.id}-admin-1`,
      email: `owner@${domain}`,
      role: "admin",
      status: "active",
      displayName: "Dana Whitfield",
      lastLoginAt: hoursAgo(5),
      invitedAt: tenant.createdAt,
    },
    {
      id: `${tenant.id}-admin-2`,
      email: `billing@${domain}`,
      role: "billing",
      status: "active",
      displayName: "Priya Raghunathan",
      lastLoginAt: daysAgo(2),
      invitedAt: daysAgo(120),
    },
    {
      id: `${tenant.id}-admin-3`,
      email: `csr@${domain}`,
      role: "agent",
      status: "invited",
      displayName: null,
      lastLoginAt: null,
      invitedAt: daysAgo(4),
    },
  ];
  // The newest tenant has only its owner so far.
  return tenant.id === "demo-tenant-4" ? base.slice(0, 1) : base;
}

function seedOperators(): DemoOperator[] {
  return [
    {
      authUserId: "demo-platform-admin-1",
      email: DEMO_PLATFORM_OPERATOR,
      displayName: "Demo Super Admin",
      status: "active",
      grantedByEmail: null,
      createdAt: daysAgo(500),
    },
    {
      authUserId: "demo-platform-admin-2",
      email: "ops@cmbreathe.example",
      displayName: "Jordan Ellis",
      status: "active",
      grantedByEmail: DEMO_PLATFORM_OPERATOR,
      createdAt: daysAgo(210),
    },
    {
      authUserId: "demo-platform-admin-3",
      email: "onboarding@cmbreathe.example",
      displayName: "Sam Okafor",
      status: "active",
      grantedByEmail: DEMO_PLATFORM_OPERATOR,
      createdAt: daysAgo(64),
    },
  ];
}

function seedContacts(): DemoContact[] {
  const mk = (
    n: number,
    email: string,
    name: string,
    company: string,
    tags: string[],
    opts: {
      unsubscribed?: boolean;
      source?: "manual" | "import";
      notes?: string;
    } = {},
  ): DemoContact => ({
    id: `demo-contact-${n}`,
    email,
    name,
    company,
    tags,
    notes: opts.notes ?? null,
    unsubscribed: opts.unsubscribed ?? false,
    unsubscribed_at: opts.unsubscribed ? daysAgo(12) : null,
    source: opts.source ?? "manual",
    created_at: daysAgo(30 + n * 6),
    updated_at: daysAgo(n),
  });
  return [
    mk(
      1,
      "kelly.moore@lakesidedme.example",
      "Kelly Moore",
      "Lakeside DME",
      ["prospect", "demo-requested"],
      { notes: "Asked for a resupply-engine walkthrough." },
    ),
    mk(
      2,
      "avery.nguyen@summitresp.example",
      "Avery Nguyen",
      "Summit Respiratory",
      ["prospect"],
      { source: "import" },
    ),
    mk(
      3,
      "chris.bell@baystatehme.example",
      "Chris Bell",
      "Bay State HME",
      ["conference-2026"],
      { source: "import" },
    ),
    mk(4, "robin.diaz@cedarcarehme.example", "Robin Diaz", "Cedar Care HME", [
      "prospect",
      "conference-2026",
    ]),
    mk(
      5,
      "taylor.reed@pinehillmedical.example",
      "Taylor Reed",
      "Pine Hill Medical",
      ["newsletter"],
      { unsubscribed: true },
    ),
    mk(
      6,
      "morgan.li@granitesleep.example",
      "Morgan Li",
      "Granite Sleep",
      ["newsletter", "prospect"],
      { source: "import" },
    ),
  ];
}

function recipientsFor(
  campaignId: string,
  contacts: DemoContact[],
): DemoCampaignRecipient[] {
  return contacts.map((c, i) => ({
    id: `${campaignId}-r${i + 1}`,
    recipientKind: "contact" as const,
    recipientEmail: c.email,
    recipientName: c.name,
    status: c.unsubscribed ? "suppressed" : i < 3 ? "sent" : "pending",
    suppressionReason: c.unsubscribed ? "unsubscribed" : null,
  }));
}

function seedCampaigns(contacts: DemoContact[]): DemoCampaign[] {
  const launch = recipientsFor("demo-campaign-1", contacts);
  const draftRecipients = recipientsFor("demo-campaign-2", contacts).map(
    (r) => ({
      ...r,
      status: r.status === "suppressed" ? "suppressed" : "pending",
    }),
  );
  return [
    {
      id: "demo-campaign-1",
      name: "Spring resupply-engine webinar",
      subject: "See the resupply engine that runs itself",
      audienceKind: "all_contacts",
      status: "sent",
      totalRecipients: launch.length,
      pendingRecipients: 0,
      suppressedCount: launch.filter((r) => r.status === "suppressed").length,
      sentCount: launch.filter((r) => r.status !== "suppressed").length,
      failedCount: 0,
      throttlePerMinute: 60,
      createdAt: daysAgo(18),
      startedAt: daysAgo(17),
      completedAt: daysAgo(17),
      cancelledAt: null,
      bodyText:
        "Hi there,\n\nWe're running a 20-minute walkthrough of the CareMetric Breathe resupply engine — eligibility checks, refill windows, and the auto-drafted orders that come out the other side.\n\nPick a time that suits you.\n\n— The CareMetric Breathe team",
      bodyHtml: null,
      audiencePayload: { kind: "all_contacts" },
      recipients: launch.map((r) => ({
        ...r,
        status: r.status === "suppressed" ? "suppressed" : "sent",
      })),
    },
    {
      id: "demo-campaign-2",
      name: "Q3 product update",
      subject: "New in CareMetric Breathe: fleet margin + vendor costs",
      audienceKind: "contacts_by_tag",
      status: "draft",
      totalRecipients: draftRecipients.length,
      pendingRecipients: draftRecipients.filter((r) => r.status === "pending")
        .length,
      suppressedCount: draftRecipients.filter((r) => r.status === "suppressed")
        .length,
      sentCount: 0,
      failedCount: 0,
      throttlePerMinute: 30,
      createdAt: daysAgo(2),
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      bodyText:
        "A quick round-up of what shipped this quarter: per-tenant margin, editable vendor cost rates, and a rebuilt tenant directory.\n\n— The CareMetric Breathe team",
      bodyHtml: null,
      audiencePayload: { kind: "contacts_by_tag", tag: "prospect" },
      recipients: draftRecipients,
    },
  ];
}

function seedTickets(): DemoTicket[] {
  return [
    {
      id: "demo-ticket-1",
      subject: "Claims stuck in 'submitted' since Tuesday",
      status: "awaiting_platform",
      botAnswered: true,
      botConfidence: 0.42,
      createdByEmail: "billing@riversidehomemedical.example",
      createdAt: daysAgo(1),
      updatedAt: hoursAgo(3),
      lastActivityAt: hoursAgo(3),
      orgId: "demo-tenant-1",
      tenant: {
        slug: "riverside-home-medical",
        name: "Riverside Home Medical",
      },
      messages: [
        {
          id: "demo-ticket-1-m1",
          authorRole: "tenant",
          authorEmail: "billing@riversidehomemedical.example",
          body: "We have about 40 claims sitting in 'submitted' since Tuesday morning and no 277CA back. Is the clearinghouse connection okay?",
          createdAt: daysAgo(1),
        },
        {
          id: "demo-ticket-1-m2",
          authorRole: "bot",
          authorEmail: null,
          body: "Claims stay in 'submitted' until the clearinghouse returns a 277CA acknowledgement. You can check the Office Ally submission log under Billing → Office Ally. If the last successful pull is older than a few hours, that's worth escalating.",
          createdAt: daysAgo(1),
        },
        {
          id: "demo-ticket-1-m3",
          authorRole: "tenant",
          authorEmail: "billing@riversidehomemedical.example",
          body: "Checked — last successful pull was Tuesday 06:10. Nothing since.",
          createdAt: hoursAgo(3),
        },
      ],
    },
    {
      id: "demo-ticket-2",
      subject: "Can we change the From name on patient email?",
      status: "awaiting_tenant",
      botAnswered: true,
      botConfidence: 0.91,
      createdByEmail: "owner@acmesleep.example",
      createdAt: daysAgo(4),
      updatedAt: daysAgo(3),
      lastActivityAt: daysAgo(3),
      orgId: "demo-tenant-2",
      tenant: { slug: "acme-sleep", name: "Acme Sleep DME" },
      messages: [
        {
          id: "demo-ticket-2-m1",
          authorRole: "tenant",
          authorEmail: "owner@acmesleep.example",
          body: "Our reminder emails go out as 'CareMetric Breathe'. We'd like them to say Acme Sleep.",
          createdAt: daysAgo(4),
        },
        {
          id: "demo-ticket-2-m2",
          authorRole: "platform",
          authorEmail: DEMO_PLATFORM_OPERATOR,
          body: "You can set your own sender under Settings → Email. One prerequisite: the sending domain has to be authenticated (SPF/DKIM) with our email provider first, otherwise mail lands in spam. Send us the domain you want to use and we'll start that off.",
          createdAt: daysAgo(3),
        },
      ],
    },
    {
      id: "demo-ticket-3",
      subject: "Fitter invite links expiring too quickly",
      status: "resolved",
      botAnswered: false,
      botConfidence: null,
      createdByEmail: "owner@northstarresp.example",
      createdAt: daysAgo(21),
      updatedAt: daysAgo(19),
      lastActivityAt: daysAgo(19),
      orgId: "demo-tenant-3",
      tenant: {
        slug: "north-star-respiratory",
        name: "North Star Respiratory",
      },
      messages: [
        {
          id: "demo-ticket-3-m1",
          authorRole: "tenant",
          authorEmail: "owner@northstarresp.example",
          body: "Our fitters say the invite link is dead by the time they open it.",
          createdAt: daysAgo(21),
        },
        {
          id: "demo-ticket-3-m2",
          authorRole: "platform",
          authorEmail: "ops@cmbreathe.example",
          body: "Raised the invite TTL for your tenant from 1 hour to 72 hours. Re-send any invite that already expired and it'll use the new window.",
          createdAt: daysAgo(19),
        },
      ],
    },
    {
      id: "demo-ticket-4",
      subject: "Request: add a second location",
      status: "open",
      botAnswered: true,
      botConfidence: 0.66,
      createdByEmail: "owner@harborbreathe.example",
      createdAt: hoursAgo(9),
      updatedAt: hoursAgo(9),
      lastActivityAt: hoursAgo(9),
      orgId: "demo-tenant-4",
      tenant: { slug: "harbor-breathe", name: "Harbor Breathe Medical" },
      messages: [
        {
          id: "demo-ticket-4-m1",
          authorRole: "tenant",
          authorEmail: "owner@harborbreathe.example",
          body: "We're opening a second storefront next month — how do we add it?",
          createdAt: hoursAgo(9),
        },
        {
          id: "demo-ticket-4-m2",
          authorRole: "bot",
          authorEmail: null,
          body: "Multiple locations are available once the multi_location.enabled feature is switched on for your tenant. I've flagged this for the platform team to enable.",
          createdAt: hoursAgo(9),
        },
      ],
    },
  ];
}

/**
 * The PLATFORM-scoped slice of the app-config catalog (the AI vendors and
 * the platform's own Twilio / Telnyx / SendGrid / Stripe credentials).
 * Category labels match `CATEGORY_*` in
 * `artifacts/resupply-api/src/lib/app-config/catalog.ts`.
 */
const CONFIG_CATALOG: ReadonlyArray<{
  key: string;
  label: string;
  description: string;
  category: string;
  secret: boolean;
  applyMode: "live" | "restart";
  placeholder: string | null;
  /** Seeded demo value; null = unset. */
  value: string | null;
  /** Seeded as supplied by the process env rather than the DB. */
  fromEnv?: boolean;
}> = [
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    description:
      "Claude powers the chatbot, admin copilot, and call summaries.",
    category: "AI vendors",
    secret: true,
    applyMode: "live",
    placeholder: "sk-ant-…",
    value: "sk-ant-demo-0000",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API key",
    description:
      "Realtime voice agent, plus the text fallback when Claude is unset.",
    category: "AI vendors",
    secret: true,
    applyMode: "live",
    placeholder: "sk-…",
    value: "sk-demo-0000",
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: "ElevenLabs API key",
    description:
      "Voice-agent speech. Unset falls back to the built-in OpenAI voice.",
    category: "AI vendors",
    secret: true,
    applyMode: "live",
    placeholder: "…",
    value: "el-demo-0000",
  },
  {
    key: "DEEPGRAM_API_KEY",
    label: "Deepgram API key",
    description: "Audit-grade backup transcript for voice calls.",
    category: "AI vendors",
    secret: true,
    applyMode: "live",
    placeholder: "…",
    value: null,
  },

  {
    key: "TWILIO_ACCOUNT_SID",
    label: "Twilio account SID",
    description: "Platform Twilio account for SMS and voice.",
    category: "Voice & telephony (Twilio)",
    secret: false,
    applyMode: "live",
    placeholder: "AC…",
    value: "ACdemo00000000000000000000000000",
    fromEnv: true,
  },
  {
    key: "TWILIO_AUTH_TOKEN",
    label: "Twilio auth token",
    description: "Paired with the account SID.",
    category: "Voice & telephony (Twilio)",
    secret: true,
    applyMode: "live",
    placeholder: "…",
    value: "demo-twilio-token",
    fromEnv: true,
  },
  {
    key: "TWILIO_PHONE_NUMBER",
    label: "Twilio phone number",
    description: "Platform fallback number when a tenant has none.",
    category: "Voice & telephony (Twilio)",
    secret: false,
    applyMode: "live",
    placeholder: "+1…",
    value: "+12155550100",
  },
  {
    key: "TWILIO_MESSAGING_SERVICE_SID",
    label: "Messaging service SID",
    description: "Optional messaging service for SMS sending.",
    category: "Voice & telephony (Twilio)",
    secret: false,
    applyMode: "live",
    placeholder: "MG…",
    value: null,
  },

  {
    key: "TELNYX_API_KEY",
    label: "Telnyx API key",
    description: "Outbound and inbound fax.",
    category: "Fax (Telnyx)",
    secret: true,
    applyMode: "live",
    placeholder: "KEY…",
    value: "KEYdemo0000",
  },
  {
    key: "TELNYX_FAX_FROM_NUMBER",
    label: "Fax from number",
    description: "Platform fallback fax number.",
    category: "Fax (Telnyx)",
    secret: false,
    applyMode: "live",
    placeholder: "+1…",
    value: "+12155550111",
  },

  {
    key: "SENDGRID_API_KEY",
    label: "SendGrid API key",
    description: "Every outbound email funnels through this key.",
    category: "Email (SendGrid)",
    secret: true,
    applyMode: "live",
    placeholder: "SG.…",
    value: "SG.demo-0000",
  },
  {
    key: "SENDGRID_FROM_NAME",
    label: "Platform From name",
    description: "Display name on platform (non-tenant) email.",
    category: "Email (SendGrid)",
    secret: false,
    applyMode: "live",
    placeholder: "CareMetric Breathe",
    value: "CareMetric Breathe",
  },

  {
    key: "STRIPE_SECRET_KEY",
    label: "Stripe secret key",
    description: "Storefront checkout for tenant patients.",
    category: "Payments (Stripe)",
    secret: true,
    applyMode: "restart",
    placeholder: "sk_live_…",
    value: "sk_test_demo0000",
  },
  {
    key: "STRIPE_WEBHOOK_SIGNING_SECRET",
    label: "Stripe webhook secret",
    description: "Verifies inbound storefront webhooks.",
    category: "Payments (Stripe)",
    secret: true,
    applyMode: "restart",
    placeholder: "whsec_…",
    value: "whsec_demo0000",
  },
  {
    key: "STRIPE_PLATFORM_SECRET_KEY",
    label: "Platform-billing secret key",
    description: "The separate Stripe account that bills tenants for the SaaS.",
    category: "Payments (Stripe)",
    secret: true,
    applyMode: "restart",
    placeholder: "sk_live_…",
    value: "sk_test_demoplatform",
  },

  {
    key: "AIRVIEW_CLIENT_ID",
    label: "ResMed AirView client id",
    description: "Nightly therapy-data pull for ResMed devices.",
    category: "Therapy cloud — ResMed AirView",
    secret: false,
    applyMode: "live",
    placeholder: "…",
    value: "airview-demo",
  },
  {
    key: "AIRVIEW_CLIENT_SECRET",
    label: "ResMed AirView client secret",
    description: "Paired with the AirView client id.",
    category: "Therapy cloud — ResMed AirView",
    secret: true,
    applyMode: "live",
    placeholder: "…",
    value: "airview-demo-secret",
  },
  {
    key: "CARE_ORCHESTRATOR_CLIENT_ID",
    label: "Philips Care Orchestrator client id",
    description: "Nightly therapy-data pull for Philips devices.",
    category: "Therapy cloud — Philips Care Orchestrator",
    secret: false,
    applyMode: "live",
    placeholder: "…",
    value: null,
  },

  {
    key: "OFFICE_ALLY_USERNAME",
    label: "Office Ally username",
    description: "SFTP account for 837P/835/277CA exchange.",
    category: "Clearinghouse (Office Ally)",
    secret: false,
    applyMode: "live",
    placeholder: "…",
    value: "oa-demo",
  },
  {
    key: "OFFICE_ALLY_ETIN",
    label: "Office Ally ETIN",
    description: "Submitter id on outbound claim files.",
    category: "Clearinghouse (Office Ally)",
    secret: false,
    applyMode: "live",
    placeholder: "…",
    value: "DEMO01",
  },

  {
    key: "SLACK_BOT_TOKEN",
    label: "Slack bot token",
    description: "Posts operational alerts and digests.",
    category: "Team notifications (Slack)",
    secret: true,
    applyMode: "live",
    placeholder: "xoxb-…",
    value: null,
  },
  {
    key: "SLACK_ALERTS_CHANNEL",
    label: "Slack alerts channel",
    description: "Channel id for operational alerts.",
    category: "Team notifications (Slack)",
    secret: false,
    applyMode: "live",
    placeholder: "C…",
    value: null,
  },
];

// ── Session-scoped mutable store ────────────────────────────────────
// Mirrors `fixtures/store.ts`: seeded lazily at first read, mutated by
// the write handlers, reset on reload (which is exactly when the demo
// toggle reloads the page), so nothing leaks between sessions.

interface PlatformState {
  tenants: DemoTenant[];
  flags: Map<string, DemoFlag[]>;
  flagActivity: Map<string, DemoFlagActivity[]>;
  tenantAdmins: Map<string, DemoTenantAdmin[]>;
  operators: DemoOperator[];
  contacts: DemoContact[];
  campaigns: DemoCampaign[];
  tickets: DemoTicket[];
  config: Map<string, DemoConfigValue>;
  configActivity: Array<{
    occurredAt: string;
    operatorEmail: string | null;
    key: string;
    label: string;
    category: string;
    action: string;
    hadPrevious: boolean;
  }>;
  costRates: DemoCostRates;
}

let state: PlatformState | null = null;

function seed(): PlatformState {
  const tenants = seedTenants();
  const contacts = seedContacts();
  const config = new Map<string, DemoConfigValue>();
  for (const s of CONFIG_CATALOG) {
    config.set(s.key, {
      value: s.value,
      updatedByEmail:
        s.value != null && !s.fromEnv ? DEMO_PLATFORM_OPERATOR : null,
      updatedAt: s.value != null && !s.fromEnv ? daysAgo(14) : null,
    });
  }
  return {
    tenants,
    flags: new Map(tenants.map((t) => [t.id, seedFlags(t)])),
    flagActivity: new Map(tenants.map((t) => [t.id, seedFlagActivity(t)])),
    tenantAdmins: new Map(tenants.map((t) => [t.id, seedTenantAdmins(t)])),
    operators: seedOperators(),
    contacts,
    campaigns: seedCampaigns(contacts),
    tickets: seedTickets(),
    config,
    configActivity: [
      {
        occurredAt: daysAgo(6),
        operatorEmail: DEMO_PLATFORM_OPERATOR,
        key: "ANTHROPIC_API_KEY",
        label: "Anthropic API key",
        category: "AI vendors",
        action: "set",
        hadPrevious: true,
      },
      {
        occurredAt: daysAgo(14),
        operatorEmail: DEMO_PLATFORM_OPERATOR,
        key: "ELEVENLABS_API_KEY",
        label: "ElevenLabs API key",
        category: "AI vendors",
        action: "set",
        hadPrevious: false,
      },
      {
        occurredAt: daysAgo(31),
        operatorEmail: "ops@cmbreathe.example",
        key: "SLACK_BOT_TOKEN",
        label: "Slack bot token",
        category: "Team notifications (Slack)",
        action: "cleared",
        hadPrevious: true,
      },
    ],
    costRates: {
      aiInputPer1mCents: 300,
      aiOutputPer1mCents: 1500,
      outboundMessageCents: 1,
      aiVoiceEventCents: 9,
      faxEventCents: 5,
    },
  };
}

function get(): PlatformState {
  if (!state) state = seed();
  return state;
}

/** A fresh demo id. Uses the Web Crypto CSPRNG, like `ids.ts`. */
function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

// ── Tenant directory + lifecycle ────────────────────────────────────

/** Strip the demo-only shaping data before a tenant crosses the wire. */
function tenantView(t: DemoTenant) {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    storefrontName: t.storefrontName,
    status: t.status,
    customDomain: t.customDomain,
    customDomainStatus: t.customDomainStatus,
    createdAt: t.createdAt,
  };
}

function tenantDetailView(t: DemoTenant) {
  return {
    ...tenantView(t),
    fromEmail: t.fromEmail,
    fromName: t.fromName,
    updatedAt: t.updatedAt,
  };
}

/** The raw roster — used by the billing fixtures to stay in step. */
export function demoPlatformTenants(): DemoTenant[] {
  return get().tenants;
}

/** GET /platform/tenants */
export function demoTenantDirectory() {
  return { tenants: get().tenants.map(tenantView) };
}

/** GET /platform/tenants/:id — null when the id isn't a demo tenant. */
export function demoTenantDetail(id: string) {
  const t = get().tenants.find((x) => x.id === id);
  return t ? { tenant: tenantDetailView(t) } : null;
}

/** POST /platform/tenants — creates and keeps it for the session. */
export function demoCreateTenant(
  body: { slug?: string; name?: string } | undefined,
) {
  const s = get();
  const slug = (body?.slug ?? "new-tenant").trim();
  const name = (body?.name ?? "New Tenant").trim();
  const tenant: DemoTenant = {
    id: newId("demo-tenant"),
    slug,
    name,
    storefrontName: name,
    status: "active",
    customDomain: null,
    customDomainStatus: null,
    createdAt: NOW_ISO(),
    fromEmail: null,
    fromName: null,
    updatedAt: NOW_ISO(),
    seed: { patients: 0, orders: 0, conversations: 0, aov: 16000 },
  };
  s.tenants.push(tenant);
  s.flags.set(
    tenant.id,
    seedFlags(tenant).map((f) => ({
      ...f,
      updatedByEmail: null,
      updatedAt: tenant.createdAt,
    })),
  );
  s.flagActivity.set(tenant.id, []);
  s.tenantAdmins.set(tenant.id, []);
  return { tenant: tenantView(tenant), flagsProvisioned: FLAG_CATALOG.length };
}

/** POST /platform/tenants/:id/{suspend,reactivate} */
export function demoSetTenantStatus(
  id: string,
  status: "active" | "suspended",
) {
  const t = get().tenants.find((x) => x.id === id);
  if (!t) return null;
  t.status = status;
  t.updatedAt = NOW_ISO();
  return { tenant: tenantView(t) };
}

/** GET /platform/tenants/:id/usage */
export function demoTenantUsage(id: string) {
  const t = get().tenants.find((x) => x.id === id);
  const seedCounts = t?.seed ?? {
    patients: 0,
    orders: 0,
    conversations: 0,
    aov: 0,
  };
  return {
    tenantId: id,
    usage: {
      patients: seedCounts.patients,
      orders: seedCounts.orders,
      conversations: seedCounts.conversations,
    },
  };
}

// ── Feature flags ───────────────────────────────────────────────────

/** GET /platform/tenants/:id/feature-flags */
export function demoTenantFlags(id: string) {
  return { tenantId: id, flags: get().flags.get(id) ?? [] };
}

/** PATCH /platform/tenants/:id/feature-flags/:key */
export function demoToggleTenantFlag(
  id: string,
  key: string,
  enabled: boolean,
) {
  const s = get();
  const flags = s.flags.get(id);
  const flag = flags?.find((f) => f.key === key);
  if (!flag) return null;
  const from = flag.enabled;
  flag.enabled = enabled;
  flag.updatedByEmail = DEMO_PLATFORM_OPERATOR;
  flag.updatedAt = NOW_ISO();
  const activity = s.flagActivity.get(id) ?? [];
  activity.unshift({
    occurredAt: NOW_ISO(),
    operatorEmail: DEMO_PLATFORM_OPERATOR,
    key,
    from,
    to: enabled,
  });
  s.flagActivity.set(id, activity);
  return { tenantId: id, flag };
}

/** GET /platform/tenants/:id/feature-flag-activity */
export function demoTenantFlagActivity(id: string, limit?: number) {
  const activity = get().flagActivity.get(id) ?? [];
  return {
    tenantId: id,
    activity: limit ? activity.slice(0, limit) : activity,
  };
}

// ── Per-tenant admins ───────────────────────────────────────────────

/** GET /platform/tenants/:id/admins */
export function demoTenantAdmins(id: string) {
  return { tenantId: id, admins: get().tenantAdmins.get(id) ?? [] };
}

/** POST /platform/tenants/:id/admins */
export function demoCreateTenantAdmin(
  id: string,
  body:
    | {
        email?: string;
        role?: string;
        displayName?: string | null;
        initialPassword?: string | null;
      }
    | undefined,
) {
  const s = get();
  const list = s.tenantAdmins.get(id) ?? [];
  const withPassword = Boolean(body?.initialPassword);
  const admin: DemoTenantAdmin = {
    id: newId("demo-admin"),
    email: (body?.email ?? "new.admin@example.com").trim().toLowerCase(),
    role: body?.role ?? "admin",
    status: withPassword ? "active" : "invited",
    displayName: body?.displayName ?? null,
    lastLoginAt: null,
    invitedAt: NOW_ISO(),
  };
  list.push(admin);
  s.tenantAdmins.set(id, list);
  return {
    tenantId: id,
    admin,
    // The demo never sends mail, so the invite path always reports "not
    // sent" and hands back the link — which is also the branch the
    // console renders most interestingly.
    emailSent: false,
    inviteLink: withPassword
      ? null
      : `https://cmbreathe.example/admin/reset-password?token=${newId("demo-invite")}`,
    signInReady: withPassword,
  };
}

// ── Impersonation ───────────────────────────────────────────────────

/** POST /platform/tenants/:id/impersonate */
export function demoImpersonate(id: string) {
  return {
    ok: true,
    impersonatingOrgId: id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

/** POST /platform/impersonation/stop */
export function demoStopImpersonation() {
  return { ok: true, stopped: true };
}

// ── Fleet overview + analytics ──────────────────────────────────────

/** GET /platform/overview */
export function demoFleetOverview() {
  return {
    tenants: get().tenants.map((t) => ({
      ...tenantView(t),
      usage: {
        patients: t.seed.patients,
        orders: t.seed.orders,
        conversations: t.seed.conversations,
      } as Record<string, number | null>,
    })),
    generatedAt: NOW_ISO(),
  };
}

/** Per-tenant window aggregates over `days`, shared by the two
 *  analytics routes so the fleet totals and a tenant's own sparkline
 *  never disagree. */
function tenantSeries(t: DemoTenant, days: number) {
  const active = t.status === "active";
  const scale = active ? 1 : 0.15;
  const newPatients = series(
    `${t.id}:p`,
    days,
    (t.seed.patients / 365) * scale + 0.4,
  );
  const orders = series(`${t.id}:o`, days, (t.seed.orders / 30) * scale + 0.3);
  const conversations = series(
    `${t.id}:c`,
    days,
    (t.seed.conversations / 30) * scale + 0.3,
  );
  const gmvCents = orders.map((n, i) =>
    Math.round(n * t.seed.aov * (0.85 + wobble(`${t.id}:g`, i) * 0.3)),
  );
  return { newPatients, orders, conversations, gmvCents };
}

function zip(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + (b[i] ?? 0));
}

/** GET /platform/analytics?days= */
export function demoPlatformAnalytics(days = 30) {
  const s = get();
  const keys = dayKeys(days);
  const zeros = keys.map(() => 0);

  let newPatients = [...zeros];
  let orders = [...zeros];
  let conversations = [...zeros];
  let gmvCents = [...zeros];

  const tenantRows = s.tenants.map((t) => {
    const ts = tenantSeries(t, days);
    newPatients = zip(newPatients, ts.newPatients);
    orders = zip(orders, ts.orders);
    conversations = zip(conversations, ts.conversations);
    gmvCents = zip(gmvCents, ts.gmvCents);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      createdAt: t.createdAt,
      patients: t.seed.patients,
      orders: t.seed.orders,
      conversations: t.seed.conversations,
      windowNewPatients: sum(ts.newPatients),
      windowOrders: sum(ts.orders),
      windowGmvCents: sum(ts.gmvCents),
    };
  });

  // A tenant counts as "new in window" when it was created inside it.
  const cutoff = Date.now() - days * 86_400_000;
  const newTenants = keys.map(
    (k) => s.tenants.filter((t) => t.createdAt.slice(0, 10) === k).length,
  );

  return {
    windowDays: days,
    generatedAt: NOW_ISO(),
    dayKeys: keys,
    totals: {
      tenants: {
        total: s.tenants.length,
        active: s.tenants.filter((t) => t.status === "active").length,
        suspended: s.tenants.filter((t) => t.status === "suspended").length,
        archived: s.tenants.filter((t) => t.status === "archived").length,
      },
      patients: s.tenants.reduce((a, t) => a + t.seed.patients, 0),
      orders: s.tenants.reduce((a, t) => a + t.seed.orders, 0),
      conversations: s.tenants.reduce((a, t) => a + t.seed.conversations, 0),
    },
    window: {
      newTenants: s.tenants.filter((t) => Date.parse(t.createdAt) >= cutoff)
        .length,
      newPatients: sum(newPatients),
      newOrders: sum(orders),
      newConversations: sum(conversations),
      gmvCents: sum(gmvCents),
      delta: {
        newPatients: delta(newPatients),
        newOrders: delta(orders),
        newConversations: delta(conversations),
        gmvCents: delta(gmvCents),
      },
    },
    series: {
      newTenants,
      newPatients,
      newOrders: orders,
      newConversations: conversations,
      gmvCents,
    },
    tenants: tenantRows,
  };
}

/** GET /platform/tenants/:id/activity-series?days= */
export function demoTenantActivitySeries(id: string, days = 30) {
  const t = get().tenants.find((x) => x.id === id);
  const keys = dayKeys(days);
  const ts = t
    ? tenantSeries(t, days)
    : {
        newPatients: keys.map(() => 0),
        orders: keys.map(() => 0),
        conversations: keys.map(() => 0),
        gmvCents: keys.map(() => 0),
      };
  return {
    tenantId: id,
    days,
    dayKeys: keys,
    window: {
      newTenants: 0,
      newPatients: sum(ts.newPatients),
      newOrders: sum(ts.orders),
      newConversations: sum(ts.conversations),
      gmvCents: sum(ts.gmvCents),
      delta: {
        newPatients: delta(ts.newPatients),
        newOrders: delta(ts.orders),
        newConversations: delta(ts.conversations),
        gmvCents: delta(ts.gmvCents),
      },
    },
    series: {
      newTenants: keys.map(() => 0),
      newPatients: ts.newPatients,
      newOrders: ts.orders,
      newConversations: ts.conversations,
      gmvCents: ts.gmvCents,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── Fleet margin ────────────────────────────────────────────────────

/** GET /platform/margin?days= */
export function demoPlatformMargin(days = 30) {
  const s = get();
  const tenants = s.tenants.map((t) => {
    const ts = tenantSeries(t, days);
    const revenueCents = sum(ts.gmvCents);
    // A slice of revenue has no cost on file (uncosted), the rest carries
    // a ~62% COGS — the same split the real aggregator reports.
    const uncostedRevenueCents = Math.round(revenueCents * 0.12);
    const costedRevenueCents = revenueCents - uncostedRevenueCents;
    const costCents = Math.round(costedRevenueCents * 0.62);
    const marginCents = costedRevenueCents - costCents;
    const lineCount = Math.max(1, sum(ts.orders) * 2);
    const linesWithUnknownCost = Math.round(lineCount * 0.12);
    const lossLineCount = Math.round(lineCount * 0.04);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      lineCount,
      revenueCents,
      costedRevenueCents,
      uncostedRevenueCents,
      costCents,
      marginCents,
      marginRatio:
        costedRevenueCents > 0 ? marginCents / costedRevenueCents : null,
      linesWithKnownCost: lineCount - linesWithUnknownCost,
      linesWithUnknownCost,
      lossLineCount,
      negativeMarginRevenueCents: Math.round(revenueCents * 0.03),
    };
  });

  const acc = (k: keyof (typeof tenants)[number]) =>
    tenants.reduce((a, t) => a + (t[k] as number), 0);
  const costedRevenueCents = acc("costedRevenueCents");
  const marginCents = acc("marginCents");

  return {
    windowDays: days,
    generatedAt: NOW_ISO(),
    fleet: {
      lineCount: acc("lineCount"),
      revenueCents: acc("revenueCents"),
      costedRevenueCents,
      uncostedRevenueCents: acc("uncostedRevenueCents"),
      costCents: acc("costCents"),
      marginCents,
      marginRatio:
        costedRevenueCents > 0 ? marginCents / costedRevenueCents : null,
      linesWithKnownCost: acc("linesWithKnownCost"),
      linesWithUnknownCost: acc("linesWithUnknownCost"),
      lossLineCount: acc("lossLineCount"),
      negativeMarginRevenueCents: acc("negativeMarginRevenueCents"),
    },
    tenants,
  };
}

// ── Vendor cost rates ───────────────────────────────────────────────

/** GET /platform/cost-rates */
export function demoCostRates() {
  return { rates: { ...get().costRates } };
}

/** PUT /platform/cost-rates — persists for the session. */
export function demoUpdateCostRates(body: Partial<DemoCostRates> | undefined) {
  const s = get();
  for (const key of Object.keys(s.costRates) as Array<keyof DemoCostRates>) {
    const next = body?.[key];
    if (typeof next === "number" && Number.isFinite(next) && next >= 0) {
      s.costRates[key] = Math.round(next);
    }
  }
  return { rates: { ...s.costRates } };
}

// ── Platform health ─────────────────────────────────────────────────

/** GET /platform/health — derived from which config keys are set, so
 *  clearing a credential on the Integrations page visibly flips a vendor
 *  dot on the Dashboard. */
export function demoPlatformHealth() {
  const cfg = get().config;
  const on = (key: string) => Boolean(cfg.get(key)?.value);
  return {
    generatedAt: NOW_ISO(),
    readiness: {
      status: "ready" as const,
      checks: { db: "ok" as const, queue: "ok" as const },
      errors: null,
      latencyMs: 24,
    },
    vendors: {
      ai: {
        anthropic: on("ANTHROPIC_API_KEY"),
        openai: on("OPENAI_API_KEY"),
        elevenlabs: on("ELEVENLABS_API_KEY"),
        deepgram: on("DEEPGRAM_API_KEY"),
      },
      comms: {
        sendgrid: on("SENDGRID_API_KEY"),
        twilioVoice: on("TWILIO_ACCOUNT_SID"),
        twilioSms: on("TWILIO_ACCOUNT_SID"),
        telnyxFax: on("TELNYX_API_KEY"),
      },
      payments: {
        stripe: on("STRIPE_SECRET_KEY"),
        platformBilling: on("STRIPE_PLATFORM_SECRET_KEY"),
      },
      storage: true,
    },
  };
}

// ── Global integrations (platform app-config) ───────────────────────

function settingView(entry: (typeof CONFIG_CATALOG)[number]) {
  const stored = get().config.get(entry.key);
  const value = stored?.value ?? null;
  const configured = value != null && value !== "";
  return {
    key: entry.key,
    label: entry.label,
    description: entry.description,
    category: entry.category,
    secret: entry.secret,
    applyMode: entry.applyMode,
    placeholder: entry.placeholder,
    configured,
    source: configured
      ? entry.fromEnv
        ? ("env" as const)
        : ("db" as const)
      : ("unset" as const),
    envProvided: Boolean(entry.fromEnv),
    hint: null,
    formatValid: configured ? true : null,
    formatHint: entry.placeholder ? `Looks like ${entry.placeholder}` : null,
    updatedByEmail: stored?.updatedByEmail ?? null,
    updatedAt: stored?.updatedAt ?? null,
  };
}

/** GET /platform/config */
export function demoPlatformConfig() {
  const order: string[] = [];
  const byCategory = new Map<string, ReturnType<typeof settingView>[]>();
  for (const entry of CONFIG_CATALOG) {
    if (!byCategory.has(entry.category)) {
      byCategory.set(entry.category, []);
      order.push(entry.category);
    }
    byCategory.get(entry.category)!.push(settingView(entry));
  }
  return {
    categories: order.map((category) => ({
      category,
      settings: byCategory.get(category)!,
    })),
    overlayDisabled: false,
    webhookReference: {
      baseUrl: "https://cmbreathe.example",
      baseUrlSource: "demo",
      pendingRestart: false,
      endpoints: [
        {
          id: "twilio-voice",
          label: "Twilio voice",
          description: "Inbound call webhook.",
          url: "https://cmbreathe.example/resupply-api/voice/incoming",
        },
        {
          id: "twilio-sms",
          label: "Twilio SMS",
          description: "Inbound SMS webhook.",
          url: "https://cmbreathe.example/resupply-api/sms/incoming",
        },
        {
          id: "stripe",
          label: "Stripe storefront",
          description: "Checkout + payment events.",
          url: "https://cmbreathe.example/resupply-api/stripe/webhook",
        },
        {
          id: "stripe-platform",
          label: "Stripe platform billing",
          description: "Tenant SaaS subscription events.",
          url: "https://cmbreathe.example/resupply-api/stripe/platform-webhook",
        },
        {
          id: "sendgrid-inbound",
          label: "SendGrid inbound parse",
          description: "Patient email replies.",
          url: "https://cmbreathe.example/resupply-api/email/inbound-parse",
        },
      ],
    },
  };
}

function catalogEntry(key: string) {
  return CONFIG_CATALOG.find((c) => c.key === key) ?? null;
}

/** PUT /platform/config/:key */
export function demoSetPlatformConfig(key: string, value: string) {
  const entry = catalogEntry(key);
  if (!entry) return null;
  const s = get();
  const hadPrevious = Boolean(s.config.get(key)?.value);
  s.config.set(key, {
    value,
    updatedByEmail: DEMO_PLATFORM_OPERATOR,
    updatedAt: NOW_ISO(),
  });
  s.configActivity.unshift({
    occurredAt: NOW_ISO(),
    operatorEmail: DEMO_PLATFORM_OPERATOR,
    key,
    label: entry.label,
    category: entry.category,
    action: "set",
    hadPrevious,
  });
  return { setting: settingView(entry) };
}

/** DELETE /platform/config/:key */
export function demoClearPlatformConfig(key: string) {
  const entry = catalogEntry(key);
  if (!entry) return null;
  const s = get();
  const hadPrevious = Boolean(s.config.get(key)?.value);
  s.config.set(key, { value: null, updatedByEmail: null, updatedAt: null });
  s.configActivity.unshift({
    occurredAt: NOW_ISO(),
    operatorEmail: DEMO_PLATFORM_OPERATOR,
    key,
    label: entry.label,
    category: entry.category,
    action: "cleared",
    hadPrevious,
  });
  return { setting: settingView(entry), removed: hadPrevious };
}

/** GET /platform/config/activity */
export function demoPlatformConfigActivity(limit?: number) {
  const activity = get().configActivity;
  return { activity: limit ? activity.slice(0, limit) : activity };
}

// ── Operator roster ─────────────────────────────────────────────────

/** GET /platform/admins */
export function demoOperators() {
  return { operators: get().operators };
}

/** POST /platform/admins */
export function demoGrantOperator(email: string | undefined) {
  const s = get();
  const normalized = (email ?? "new.operator@cmbreathe.example")
    .trim()
    .toLowerCase();
  const existing = s.operators.find((o) => o.email === normalized);
  if (existing) return { operator: existing, created: false };
  const operator: DemoOperator = {
    authUserId: newId("demo-platform-admin"),
    email: normalized,
    displayName: null,
    status: "active",
    grantedByEmail: DEMO_PLATFORM_OPERATOR,
    createdAt: NOW_ISO(),
  };
  s.operators.push(operator);
  return { operator, created: true };
}

/** DELETE /platform/admins/:authUserId */
export function demoRevokeOperator(authUserId: string) {
  const s = get();
  s.operators = s.operators.filter((o) => o.authUserId !== authUserId);
  return { ok: true, removed: authUserId };
}

// ── Support queue ───────────────────────────────────────────────────

function ticketView(t: DemoTicket) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    botAnswered: t.botAnswered,
    botConfidence: t.botConfidence,
    createdByEmail: t.createdByEmail,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastActivityAt: t.lastActivityAt,
    orgId: t.orgId,
    tenant: t.tenant,
  };
}

/** GET /platform/support/tickets?status= */
export function demoPlatformTickets(status?: string | null) {
  const all = get().tickets;
  const counts: Record<string, number> = { all: all.length };
  for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const tickets = status ? all.filter((t) => t.status === status) : all;
  return {
    tickets: [...tickets]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map(ticketView),
    counts,
  };
}

/** GET /platform/support/tickets/:id */
export function demoPlatformTicket(id: string) {
  const t = get().tickets.find((x) => x.id === id);
  if (!t) return null;
  return { ticket: ticketView(t), messages: t.messages };
}

/** POST /platform/support/tickets/:id/reply */
export function demoReplyPlatformTicket(id: string, body: string) {
  const t = get().tickets.find((x) => x.id === id);
  if (!t) return null;
  t.messages.push({
    id: newId("demo-ticket-msg"),
    authorRole: "platform",
    authorEmail: DEMO_PLATFORM_OPERATOR,
    body,
    createdAt: NOW_ISO(),
  });
  // A platform reply hands the thread back to the tenant, exactly like
  // the real route.
  t.status = "awaiting_tenant";
  t.updatedAt = NOW_ISO();
  t.lastActivityAt = NOW_ISO();
  return { ticket: ticketView(t), messages: t.messages };
}

/** POST /platform/support/tickets/:id/status */
export function demoSetPlatformTicketStatus(id: string, status: string) {
  const t = get().tickets.find((x) => x.id === id);
  if (!t) return null;
  t.status = status as DemoTicketStatus;
  t.updatedAt = NOW_ISO();
  t.lastActivityAt = NOW_ISO();
  return { ticket: ticketView(t) };
}

// ── Outreach: contacts ──────────────────────────────────────────────

/** GET /platform/contacts?search=&tag= */
export function demoPlatformContacts(
  search?: string | null,
  tag?: string | null,
) {
  let contacts = get().contacts;
  if (tag) contacts = contacts.filter((c) => c.tags.includes(tag));
  if (search) {
    const q = search.toLowerCase();
    contacts = contacts.filter(
      (c) =>
        c.email.toLowerCase().includes(q) ||
        (c.name ?? "").toLowerCase().includes(q) ||
        (c.company ?? "").toLowerCase().includes(q),
    );
  }
  return { contacts };
}

/** POST /platform/contacts */
export function demoCreateContact(
  body:
    | {
        email?: string;
        name?: string | null;
        company?: string | null;
        tags?: string[];
        notes?: string | null;
      }
    | undefined,
) {
  const s = get();
  const email = (body?.email ?? "new.contact@example.com").trim().toLowerCase();
  const existing = s.contacts.find((c) => c.email === email);
  if (existing) return { contact: existing };
  const contact: DemoContact = {
    id: newId("demo-contact"),
    email,
    name: body?.name ?? null,
    company: body?.company ?? null,
    tags: body?.tags ?? [],
    notes: body?.notes ?? null,
    unsubscribed: false,
    unsubscribed_at: null,
    source: "manual",
    created_at: NOW_ISO(),
    updated_at: NOW_ISO(),
  };
  s.contacts.unshift(contact);
  return { contact };
}

/** PATCH /platform/contacts/:id */
export function demoUpdateContact(
  id: string,
  body:
    | Partial<{
        name: string | null;
        company: string | null;
        tags: string[];
        notes: string | null;
        unsubscribed: boolean;
      }>
    | undefined,
) {
  const contact = get().contacts.find((c) => c.id === id);
  if (!contact) return null;
  if (body?.name !== undefined) contact.name = body.name;
  if (body?.company !== undefined) contact.company = body.company;
  if (body?.tags !== undefined) contact.tags = body.tags;
  if (body?.notes !== undefined) contact.notes = body.notes;
  if (body?.unsubscribed !== undefined) {
    contact.unsubscribed = body.unsubscribed;
    contact.unsubscribed_at = body.unsubscribed ? NOW_ISO() : null;
  }
  contact.updated_at = NOW_ISO();
  return { contact };
}

/** DELETE /platform/contacts/:id */
export function demoDeleteContact(id: string) {
  const s = get();
  s.contacts = s.contacts.filter((c) => c.id !== id);
  return { ok: true as const };
}

/** POST /platform/contacts/:id/unsubscribe */
export function demoUnsubscribeContact(id: string) {
  const contact = get().contacts.find((c) => c.id === id);
  if (!contact) return null;
  contact.unsubscribed = true;
  contact.unsubscribed_at = NOW_ISO();
  contact.updated_at = NOW_ISO();
  return { contact };
}

/** POST /platform/contacts/import — accepts pasted text or rows. */
export function demoImportContacts(
  body:
    | {
        raw?: string;
        contacts?: Array<{
          email: string;
          name?: string | null;
          company?: string | null;
        }>;
        tags?: string[];
      }
    | undefined,
) {
  const s = get();
  const tags = body?.tags ?? [];
  const rows: Array<{
    email: string;
    name?: string | null;
    company?: string | null;
  }> = [];

  if (body?.contacts?.length) rows.push(...body.contacts);
  if (body?.raw) {
    // Tolerant of "email", "Name <email>" and comma/tab-separated rows —
    // the same shapes the real importer accepts.
    for (const line of body.raw.split(/[\r\n]+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(trimmed);
      if (!match) continue;
      const email = match[0].toLowerCase();
      const name = trimmed
        .replace(match[0], "")
        .replace(/[<>,;\t]/g, "")
        .trim();
      rows.push({ email, name: name || null });
    }
  }

  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email || s.contacts.some((c) => c.email === email)) {
      skipped += 1;
      continue;
    }
    s.contacts.unshift({
      id: newId("demo-contact"),
      email,
      name: row.name ?? null,
      company: row.company ?? null,
      tags,
      notes: null,
      unsubscribed: false,
      unsubscribed_at: null,
      source: "import",
      created_at: NOW_ISO(),
      updated_at: NOW_ISO(),
    });
    imported += 1;
  }
  return { imported, skipped };
}

// ── Outreach: campaigns ─────────────────────────────────────────────

function campaignSummary(c: DemoCampaign) {
  const {
    bodyText: _b,
    bodyHtml: _h,
    audiencePayload: _a,
    recipients: _r,
    ...summary
  } = c;
  return summary;
}

/** GET /platform/email-campaigns */
export function demoPlatformCampaigns() {
  return {
    campaigns: [...get().campaigns]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(campaignSummary),
  };
}

/** GET /platform/email-campaigns/:id */
export function demoPlatformCampaign(id: string) {
  const c = get().campaigns.find((x) => x.id === id);
  return c ?? null;
}

/** POST /platform/email-campaigns/draft */
export function demoCreateCampaignDraft(
  body:
    | {
        name?: string;
        subject?: string;
        bodyText?: string;
        bodyHtml?: string | null;
        audienceKind?: DemoCampaign["audienceKind"];
        tenantIds?: string[];
        tag?: string;
        emails?: string[];
        throttlePerMinute?: number;
      }
    | undefined,
) {
  const s = get();
  const id = newId("demo-campaign");
  const audienceKind = body?.audienceKind ?? "all_contacts";

  let recipients: DemoCampaignRecipient[];
  if (audienceKind === "all_tenants" || audienceKind === "selected_tenants") {
    const pool =
      audienceKind === "all_tenants"
        ? s.tenants
        : s.tenants.filter((t) => (body?.tenantIds ?? []).includes(t.id));
    recipients = pool.map((t, i) => ({
      id: `${id}-r${i + 1}`,
      recipientKind: "tenant" as const,
      recipientEmail:
        t.fromEmail ?? `owner@${t.slug.replace(/-/g, "")}.example`,
      recipientName: t.name,
      status: "pending",
      suppressionReason: null,
    }));
  } else if (audienceKind === "manual_list") {
    recipients = (body?.emails ?? []).map((email, i) => ({
      id: `${id}-r${i + 1}`,
      recipientKind: "manual" as const,
      recipientEmail: email,
      recipientName: null,
      status: "pending",
      suppressionReason: null,
    }));
  } else {
    const pool =
      audienceKind === "contacts_by_tag" && body?.tag
        ? s.contacts.filter((c) => c.tags.includes(body.tag!))
        : s.contacts;
    recipients = pool.map((c, i) => ({
      id: `${id}-r${i + 1}`,
      recipientKind: "contact" as const,
      recipientEmail: c.email,
      recipientName: c.name,
      status: c.unsubscribed ? "suppressed" : "pending",
      suppressionReason: c.unsubscribed ? "unsubscribed" : null,
    }));
  }

  const suppressed = recipients.filter((r) => r.status === "suppressed").length;
  const pending = recipients.length - suppressed;
  const campaign: DemoCampaign = {
    id,
    name: body?.name ?? "Untitled campaign",
    subject: body?.subject ?? "(no subject)",
    audienceKind,
    status: "draft",
    totalRecipients: recipients.length,
    pendingRecipients: pending,
    suppressedCount: suppressed,
    sentCount: 0,
    failedCount: 0,
    throttlePerMinute: body?.throttlePerMinute ?? 60,
    createdAt: NOW_ISO(),
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    bodyText: body?.bodyText ?? "",
    bodyHtml: body?.bodyHtml ?? null,
    audiencePayload: {
      kind: audienceKind,
      tag: body?.tag,
      tenantIds: body?.tenantIds,
    },
    recipients,
  };
  s.campaigns.unshift(campaign);
  return {
    id,
    totals: { total: recipients.length, pending, suppressed },
  };
}

/** POST /platform/email-campaigns/:id/{start,pause,resume,cancel} */
export function demoCampaignAction(
  id: string,
  action: "start" | "pause" | "resume" | "cancel",
) {
  const c = get().campaigns.find((x) => x.id === id);
  if (!c) return null;
  if (action === "start" || action === "resume") {
    c.status = "sending";
    c.startedAt = c.startedAt ?? NOW_ISO();
    c.cancelledAt = null;
    // Advance a slice of the queue so the progress counters visibly move
    // each time the operator acts — the demo's stand-in for the worker.
    const batch = c.recipients
      .filter((r) => r.status === "pending")
      .slice(0, 2);
    for (const r of batch) r.status = "sent";
    c.sentCount = c.recipients.filter((r) => r.status === "sent").length;
    c.pendingRecipients = c.recipients.filter(
      (r) => r.status === "pending",
    ).length;
    if (c.pendingRecipients === 0) {
      c.status = "sent";
      c.completedAt = NOW_ISO();
    }
  } else if (action === "pause") {
    c.status = "paused";
  } else {
    c.status = "cancelled";
    c.cancelledAt = NOW_ISO();
    c.pendingRecipients = 0;
  }
  return { id: c.id, status: c.status };
}

// ── Connection tests ────────────────────────────────────────────────

/** GET /platform/connection-tests/status */
export function demoConnectionTestStatus() {
  const cfg = get().config;
  const on = (key: string) => Boolean(cfg.get(key)?.value);
  return {
    email: { configured: on("SENDGRID_API_KEY") },
    sms: { configured: on("TWILIO_ACCOUNT_SID") },
    voice: { configured: on("TWILIO_ACCOUNT_SID") },
    chat: {
      configured: on("ANTHROPIC_API_KEY") || on("OPENAI_API_KEY"),
      provider: on("ANTHROPIC_API_KEY")
        ? ("anthropic" as const)
        : on("OPENAI_API_KEY")
          ? ("openai" as const)
          : ("offline" as const),
    },
  };
}

/**
 * POST /platform/connection-tests/{email,sms,voice,chat}
 *
 * No vendor round-trip happens in demo mode — the sandbox never reaches a
 * real network. The result still mirrors the real contract: a channel
 * whose credential is unset reports `ok: false, code: "not_configured"`
 * (a 200, not an HTTP error), so clearing e.g. the SendGrid key on the
 * Integrations page and re-running the email test shows the real failure
 * path rather than a fake success.
 */
export function demoConnectionTest(
  channel: "email" | "sms" | "voice" | "chat",
  target?: string,
) {
  const status = demoConnectionTestStatus();
  const configured = status[channel].configured;
  if (!configured) {
    return {
      ok: false as const,
      channel,
      code: "not_configured" as const,
      message:
        channel === "chat"
          ? "No AI provider is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY under Global integrations."
          : `No credential is configured for ${channel}. Add it under Global integrations.`,
    };
  }
  const detail: Record<string, string | number | null> =
    channel === "chat"
      ? {
          provider: status.chat.provider,
          model: "claude-sonnet-4-6",
          latencyMs: 412,
          reply: "Demo round-trip OK.",
        }
      : channel === "email"
        ? {
            to: target ?? "demo@cmbreathe.example",
            from: "noreply@cmbreathe.com",
            statusCode: 202,
            messageId: newId("demo-msg"),
          }
        : {
            to: target ?? "+12155550123",
            from: "+12155550100",
            sid: newId("demo-sid"),
            status: channel === "sms" ? "queued" : "initiated",
          };
  return { ok: true as const, channel, detail };
}

// ── Deployment launch checklist ─────────────────────────────────────

/** GET /platform/account-setup */
export function demoAccountSetup() {
  const cfg = get().config;
  const on = (key: string) => Boolean(cfg.get(key)?.value);
  const item = (
    id: string,
    tab: "required" | "optional",
    group: string,
    title: string,
    description: string,
    status: string,
    detail: string | null,
    extras: { docHref?: string | null; command?: string | null } = {},
  ) => ({
    id,
    tab,
    group,
    title,
    description,
    status,
    detail,
    docHref: extras.docHref ?? null,
    command: extras.command ?? null,
  });

  return {
    generatedAt: NOW_ISO(),
    environment: "demo",
    items: [
      item(
        "supabase",
        "required",
        "Data",
        "Supabase project",
        "The runtime data path for every route and worker.",
        "ok",
        "Both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.",
      ),
      item(
        "database-url",
        "required",
        "Data",
        "Postgres connection",
        "Used by the migrator and a few legacy worker paths.",
        "ok",
        "DATABASE_URL is set.",
      ),
      item(
        "migrations",
        "required",
        "Data",
        "Migrations applied",
        "The migration ledger is current for this deploy.",
        "ok",
        "Ledger adopted; no pending migrations.",
      ),
      item(
        "link-hmac",
        "required",
        "Security",
        "Patient link signing key",
        "Signs the short-lived links in SMS and email reminders.",
        "ok",
        "RESUPPLY_LINK_HMAC_KEY is set (48 bytes).",
      ),
      item(
        "cors",
        "required",
        "Security",
        "Allowed origins",
        "The API refuses to boot in production without an origin allowlist.",
        "ok",
        "RAILWAY_PUBLIC_DOMAIN is set.",
      ),
      item(
        "first-admin",
        "required",
        "Access",
        "First admin account",
        "At least one admin can sign in to the console.",
        "ok",
        "3 active admins on the seed tenant.",
      ),
      item(
        "storage-bucket",
        "required",
        "Storage",
        "Private storage bucket",
        "Where POD photos, prescriptions and MMS media land.",
        "ok",
        "SUPABASE_STORAGE_BUCKET_PRIVATE is set.",
      ),
      item(
        "sendgrid",
        "optional",
        "Communications",
        "Email (SendGrid)",
        "Outbound patient and operator email.",
        on("SENDGRID_API_KEY") ? "ok" : "missing",
        on("SENDGRID_API_KEY")
          ? "API key set; platform From is noreply@cmbreathe.com."
          : "SENDGRID_API_KEY is unset — email is disabled.",
      ),
      item(
        "twilio",
        "optional",
        "Communications",
        "SMS + voice (Twilio)",
        "Reminders over SMS and the AI voice agent.",
        on("TWILIO_ACCOUNT_SID") ? "ok" : "missing",
        on("TWILIO_ACCOUNT_SID")
          ? "Account SID and auth token set."
          : "TWILIO_ACCOUNT_SID is unset — SMS and voice are disabled.",
      ),
      item(
        "telnyx",
        "optional",
        "Communications",
        "Fax (Telnyx)",
        "Inbound and outbound fax.",
        on("TELNYX_API_KEY") ? "ok" : "missing",
        on("TELNYX_API_KEY")
          ? "API key set."
          : "TELNYX_API_KEY is unset — fax is disabled.",
      ),
      item(
        "ai",
        "optional",
        "AI",
        "AI providers",
        "Chatbot, admin copilot, voice agent, call summaries.",
        on("ANTHROPIC_API_KEY") || on("OPENAI_API_KEY") ? "ok" : "missing",
        on("ANTHROPIC_API_KEY")
          ? "Claude is primary; OpenAI is the fallback."
          : on("OPENAI_API_KEY")
            ? "OpenAI only — Claude is unset."
            : "No AI provider configured; assistants reply offline.",
      ),
      item(
        "stripe",
        "optional",
        "Payments",
        "Platform Stripe (SaaS)",
        "Tenant CareMetric Breathe subscription billing — not patient checkout.",
        on("STRIPE_SECRET_KEY") || on("STRIPE_PLATFORM_SECRET_KEY")
          ? "ok"
          : "missing",
        on("STRIPE_SECRET_KEY") || on("STRIPE_PLATFORM_SECRET_KEY")
          ? "Platform billing key detected."
          : "Stripe platform key unset — tenant SaaS checkout degrades.",
      ),
      item(
        "platform-billing",
        "optional",
        "Payments",
        "Platform billing (Stripe)",
        "The separate account that bills tenants for the SaaS.",
        on("STRIPE_PLATFORM_SECRET_KEY") ? "ok" : "missing",
        on("STRIPE_PLATFORM_SECRET_KEY")
          ? "Test-mode platform key detected."
          : "STRIPE_PLATFORM_SECRET_KEY is unset.",
      ),
      item(
        "therapy-clouds",
        "optional",
        "Integrations",
        "Therapy clouds",
        "Nightly device-data pulls from ResMed / Philips / 3B.",
        on("AIRVIEW_CLIENT_ID") ? "ok" : "missing",
        on("AIRVIEW_CLIENT_ID")
          ? "ResMed AirView configured; Philips and 3B unset."
          : "No therapy cloud configured.",
      ),
      item(
        "clearinghouse",
        "optional",
        "Integrations",
        "Clearinghouse (Office Ally)",
        "837P claim submission and 835/277CA pickup.",
        on("OFFICE_ALLY_USERNAME") ? "ok" : "missing",
        on("OFFICE_ALLY_USERNAME")
          ? "SFTP credentials set."
          : "OFFICE_ALLY_USERNAME is unset — claims write to the file outbox.",
      ),
      item(
        "slack",
        "optional",
        "Integrations",
        "Slack notifications",
        "Operational alerts and digests.",
        on("SLACK_BOT_TOKEN") ? "ok" : "missing",
        on("SLACK_BOT_TOKEN") ? "Bot token set." : "SLACK_BOT_TOKEN is unset.",
      ),
    ],
  };
}

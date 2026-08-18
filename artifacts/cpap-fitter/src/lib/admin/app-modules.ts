// App modules — the coarse "parts of the app" a tenant can switch on and
// off (migration 0488, `module.*` feature flags).
//
// Why these are separate from the rest of the Control Center:
//   Every other flag on that page is an INCIDENT switch — pause the
//   dispatcher, stop auto-submitting claims, take the voice agent
//   offline. You flip one when something is wrong, and flip it back.
//   A `module.*` key is a SETUP decision: "we're cash-pay, we will never
//   open a claims worklist". Mixing the two in one long alphabetical
//   list is how a tenant ends up scrolling past forty switches to find
//   the one that removes forty pages.
//
// Turning a module off subtracts it from the sidebar (see
// filterNavGroupsByFeature in components/admin/nav-traversal.ts) and
// turns a deep link into it into an explanatory notice. It does NOT
// delete data, revoke access, or stop automation that is already
// running — the server-side permission gates are untouched, and a
// module switched back on restores everything exactly as it was.
//
// Keep in lockstep with migration 0488 and with FEATURE_FLAG_KEYS in
// artifacts/resupply-api/src/lib/feature-flags.ts.

export interface AppModule {
  /** The `module.*` feature-flag key. */
  key: string;
  /** Short label — what an operator calls this part of the app. */
  label: string;
  /** One line: what disappears from the console when this is off. */
  hides: string;
  /** The sidebar group the module lives under, for grouping the card. */
  group: string;
}

export const APP_MODULES: ReadonlyArray<AppModule> = [
  {
    key: "module.front_desk",
    label: "Front desk",
    hides: "Walk-in capture and counter sales.",
    group: "Workspace",
  },
  {
    key: "module.conversations",
    label: "Conversations & cases",
    hides: "The inbound SMS / MMS / email inbox, cases, and episodes.",
    group: "Workspace",
  },
  {
    key: "module.schedule",
    label: "Scheduling",
    hides: "Company calendar, video visits, and the follow-up queue.",
    group: "Workspace",
  },
  {
    key: "module.outreach",
    label: "Outreach",
    hides:
      "Bulk campaigns, alerts, reminders, playbooks, and message templates.",
    group: "Workspace",
  },
  {
    key: "module.documents",
    label: "Documents & e-sign",
    hides:
      "Patient documents, packets, signature tracking, faxes, and referral review.",
    group: "Patients & Clinical",
  },
  {
    key: "module.therapy",
    label: "Therapy monitoring",
    hides:
      "RT overview, therapy fleet, setup adherence, and resupply opportunities.",
    group: "Patients & Clinical",
  },
  {
    key: "module.clinical",
    label: "Clinical work",
    hides:
      "Encounters, interventions, fit review, mask catalog, formulary, and coaching.",
    group: "Patients & Clinical",
  },
  {
    key: "module.providers",
    label: "Providers & recalls",
    hides: "Referring providers, equipment recalls, and asset recovery.",
    group: "Patients & Clinical",
  },
  {
    key: "module.storefront",
    label: "Storefront & leads",
    hides:
      "Shop customers, reviews, product Q&A, carts, leads, and fitter invites.",
    group: "Orders & Shop",
  },
  {
    key: "module.inventory",
    label: "Inventory",
    hides: "Stock levels and reconciliation.",
    group: "Orders & Shop",
  },
  {
    key: "module.billing",
    label: "Billing & claims",
    hides:
      "The whole Billing group — dashboards, worklists, A/R, and clearinghouse tools. Your own plan stays under Settings.",
    group: "Billing",
  },
  {
    key: "module.analytics",
    label: "Analytics & reports",
    hides: "The whole Analytics & Reports group.",
    group: "Analytics & Reports",
  },
  {
    key: "module.automation",
    label: "Automation rules",
    hides: "Rules, compliance rules, and the rule tester.",
    group: "System",
  },
  {
    key: "module.integrations",
    label: "Integrations",
    hides: "Partner integrations, PacWare, and webhook deliveries.",
    group: "System",
  },
  {
    key: "module.support",
    label: "Support",
    hides: "Support tickets and help resources.",
    group: "System",
  },
];

const BY_KEY = new Map(APP_MODULES.map((m) => [m.key, m]));

/** True for a `module.*` key this build knows about. */
export function isAppModuleKey(key: string): boolean {
  return BY_KEY.has(key);
}

/**
 * Human label for a flag key, for the "this part of the app is turned
 * off" notice. Falls back to the raw key so a module seeded by a NEWER
 * migration than this build still names itself intelligibly.
 */
export function appModuleLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

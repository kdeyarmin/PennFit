// /admin/billing/config — billing configuration console.
//
// Landing card-grid for the seven config surfaces that drive the
// scrubber + claim-builder + fee-schedule lookups + denial analyzer.
// None of these had admin UI before; everything was reachable only via
// direct API.
//
// Editing has since landed for several: organization identity,
// clearinghouse connection, payer profiles, and fee schedules are
// create/edit-able from their sub-pages. Modifier rules, denial codes,
// and claim templates are still read-only here (managed by engineering)
// — their sub-pages list current state so we can spot rules that fired
// in denials worth investigating.

import { Link } from "wouter";
import {
  BookOpen,
  Building2,
  CircleSlash,
  DollarSign,
  ListChecks,
  PlugZap,
  Sliders,
} from "lucide-react";

import { Card } from "@/components/admin/Card";

const SECTIONS: ReadonlyArray<{
  href: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    href: "/admin/billing/config/organization",
    label: "Organization identity",
    description:
      "Your DME billing identity — legal name, tax ID, organizational NPI, addresses, accreditation. Used on every claim (837P), eligibility request (270), and HCFA form. Set here instead of in global OFFICE_ALLY_BILLING_* env vars.",
    icon: Building2,
  },
  {
    href: "/admin/billing/config/clearinghouse",
    label: "Clearinghouse connection",
    description:
      "Office Ally SFTP connection + submitter ETIN used to transmit claims (837P) and eligibility (270/271). DB-backed, preferred over OFFICE_ALLY_* env vars. Key files stay on the server — only their paths are stored here.",
    icon: PlugZap,
  },
  {
    href: "/admin/billing/config/payers",
    label: "Payer profiles",
    description:
      "Pennsylvania payer catalog — legal names, electronic IDs, LOB, prior-auth flags, provider portal URLs.",
    icon: Building2,
  },
  {
    href: "/admin/billing/config/fee-schedules",
    label: "Fee schedules",
    description:
      "Per-payer + HCPCS expected-allowed amounts. Source of truth for the patient-cost estimator and EOB variance alerts.",
    icon: DollarSign,
  },
  {
    href: "/admin/billing/config/modifier-rules",
    label: "Modifier rules",
    description:
      "Payer-specific HCPCS modifier policy — which modifiers to apply when and why.",
    icon: Sliders,
  },
  {
    href: "/admin/billing/config/denial-codes",
    label: "Denial codes",
    description:
      "CARC / RARC catalog the AI denial analyzer matches against. ~50 codes DME suppliers hit most often.",
    icon: CircleSlash,
  },
  {
    href: "/admin/billing/config/claim-templates",
    label: "Claim templates",
    description:
      "Reusable HCPCS line patterns the claim-builder snaps to when fulfillments are billed.",
    icon: ListChecks,
  },
];

export function AdminBillingConfigHubPage() {
  return (
    <div
      className="admin-root space-y-6 max-w-5xl"
      data-testid="admin-billing-config"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Billing config
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          The configuration that drives the scrubber, claim-builder,
          fee-schedule lookups, and denial analyzer. Some sections are editable
          here; others are still read-only.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a24a] focus-visible:ring-offset-2"
            data-testid={`config-section-${s.href.split("/").pop()}`}
          >
            <Card>
              <div className="flex items-start gap-3">
                <s.icon className="h-5 w-5 mt-0.5 shrink-0" />
                <div>
                  <p
                    className="font-semibold text-sm"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {s.label}
                  </p>
                  <p
                    className="text-xs mt-1 leading-snug"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {s.description}
                  </p>
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>

      <Card title="What's editable here">
        <ul
          className="text-sm space-y-1.5"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          <li className="flex items-start gap-2">
            <BookOpen className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>Editable in-app:</strong> organization identity,
              clearinghouse connection, payer profiles, and fee schedules —
              create / edit from each sub-page.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <BookOpen className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>Read-only (managed by engineering):</strong> modifier
              rules, denial codes, and claim templates. Their sub-pages show
              current state so you can spot rules that fired in denials worth
              investigating.
            </span>
          </li>
        </ul>
      </Card>
    </div>
  );
}

// /admin/billing/config — billing configuration console.
//
// Landing card-grid for the five payer-config surfaces that drive
// the scrubber + claim-builder + denial analyzer. None of these had
// admin UI before; everything was reachable only via direct API.
//
// This page is read-only and intentionally lightweight — each card
// links to a sub-page that lists the rows. Mutation surfaces (create
// / edit) are still backend-only and will land in follow-ups once
// the UX of inline editing is settled.

import { Link } from "wouter";
import {
  BookOpen,
  Building2,
  CircleSlash,
  DollarSign,
  ListChecks,
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
          fee-schedule lookups, and denial analyzer. Read-only here — edits
          still go through engineering.
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

      <Card title="What edits are gated">
        <ul
          className="text-sm space-y-1.5"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          <li className="flex items-start gap-2">
            <BookOpen className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Mutations on these tables (create / edit / soft-delete) still go
              through admin-only API routes. The SPA shows the current state and
              lets us spot rules that fired in denials we want to investigate.
            </span>
          </li>
        </ul>
      </Card>
    </div>
  );
}

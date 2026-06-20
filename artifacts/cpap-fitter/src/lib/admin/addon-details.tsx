import { ChevronDown } from "lucide-react";

import type { BillingAddon } from "@/lib/admin/platform-billing-api";

/** Plain-language explainer for each add-on, keyed by catalog `code`:
 *  what the add-on actually does and why it's worth having as part of the
 *  package. Surfaced in a collapsible dropdown under each add-on so operators
 *  can make an informed choice without contacting sales. Codes match the seed
 *  catalog (migration 0362); unknown codes render no explainer (the add-on's
 *  own `description` already covers them). Shared by the tenant
 *  "Billing package & usage" page and the super-admin platform billing
 *  console. */
export const ADDON_DETAILS: Record<
  string,
  { whatItDoes: string; whyItMatters: string }
> = {
  additional_seat: {
    whatItDoes:
      "Adds one more admin/staff login beyond your plan's included seats.",
    whyItMatters:
      "Every team member should have their own secure login rather than sharing one — it keeps activity attributable, protects PHI, and means no one gets locked out as your team grows.",
  },
  active_patient_block: {
    whatItDoes: "Raises your active-patient ceiling by 500 patients/customers.",
    whyItMatters:
      "Your plan caps how many active patients you can manage at once. Adding a block before you hit the limit keeps resupply reminders and new orders flowing instead of stalling when your roster grows.",
  },
  additional_location: {
    whatItDoes: "Adds one more serviced business branch or location.",
    whyItMatters:
      "If you operate from more than one storefront or branch, each needs its own location record so orders route correctly and inventory and reporting stay accurate per site.",
  },
  message_bundle: {
    whatItDoes: "Adds 1,000 outbound SMS/email messages to your monthly pool.",
    whyItMatters:
      "Resupply reminders and order updates go out by text and email — the single biggest driver of repeat orders. Running out mid-month silently stops that outreach, so a bundle keeps patient communication uninterrupted.",
  },
  ai_text_bundle: {
    whatItDoes: "Adds 1,000 AI text interactions to your monthly pool.",
    whyItMatters:
      "These power the storefront chatbot, sleep coach, admin assistant, and email auto-replies. The bundle keeps the assistants answering patients and staff once you pass the plan's included interactions.",
  },
  billing_transaction_bundle: {
    whatItDoes:
      "Adds 1,000 claims, eligibility, or billing transactions per month.",
    whyItMatters:
      "Every insurance eligibility check and claim submission counts as a transaction. The bundle ensures billing keeps processing during high-volume months instead of holding up reimbursement.",
  },
  storage_100gb: {
    whatItDoes: "Adds 100 GB of document and attachment storage.",
    whyItMatters:
      "Prescription PDFs, proof-of-delivery photos, and inbound MMS attachments accumulate over time. Extra storage prevents upload failures and keeps required documentation on hand.",
  },
  ai_voice_agent: {
    whatItDoes: "Turns on the AI voice agent and IVR call automation.",
    whyItMatters:
      "It answers and places resupply calls automatically — freeing staff from the phones, capturing orders after hours, and scaling outreach without adding headcount.",
  },
  advanced_billing_automation: {
    whatItDoes:
      "Enables auto-submit, the AI work queue, denial analyzer, and payer rules.",
    whyItMatters:
      "Billing is the most labor-intensive part of DME. Automating submission and surfacing why claims are denied recovers revenue that otherwise leaks away and cuts manual rework.",
  },
  fax_automation: {
    whatItDoes: "Automates outbound and inbound fax workflows.",
    whyItMatters:
      "DME still runs on fax for prescriptions and prior authorizations. Automating it removes manual faxing and keeps required documents moving without a staffer babysitting the machine.",
  },
  additional_therapy_vendor: {
    whatItDoes:
      "Adds one more therapy-cloud vendor connection (e.g. ResMed, Philips, 3B).",
    whyItMatters:
      "Pulling device usage and compliance data straight from the manufacturer's cloud lets you serve patients across more device brands without manual data entry.",
  },
  advanced_analytics: {
    whatItDoes:
      "Unlocks financial, attribution, LTV/CAC, channel, and inventory analytics.",
    whyItMatters:
      "Shows where your revenue and customers actually come from so you can invest in the channels that work and spot inventory or margin problems before they cost you.",
  },
  multi_location_management: {
    whatItDoes:
      "Enables multi-branch workflows when they aren't included in your plan.",
    whyItMatters:
      "Coordinate inventory, staffing, and reporting across every branch from one place instead of running each location as a disconnected silo.",
  },
  data_migration: {
    whatItDoes:
      "A one-time project to import your existing patients, orders, and history.",
    whyItMatters:
      "Getting your current data in cleanly means you launch fully operational — with resupply timing and history intact — instead of starting from an empty system.",
  },
  custom_domain_branding_setup: {
    whatItDoes: "One-time setup of your own domain and storefront branding.",
    whyItMatters:
      "Running the storefront on your own domain with your brand keeps customers seeing you — not a generic platform — which builds trust and protects your brand equity.",
  },
  dedicated_success_manager: {
    whatItDoes:
      "Assigns a dedicated customer-success owner with recurring workflow reviews.",
    whyItMatters:
      "A named expert who knows your account proactively reviews your workflows and helps you get more value, rather than starting from scratch with general support each time.",
  },
  custom_integration: {
    whatItDoes: "Scoped custom integration work for a system you already use.",
    whyItMatters:
      "Connects the platform to tools that aren't covered out of the box so your existing systems keep working together instead of forcing manual double-entry.",
  },
};

/** Collapsible "what this does & why it matters" explainer rendered under
 *  an add-on. Uses a native <details> element so it needs no extra state and
 *  stays accessible. Renders nothing when no richer copy is mapped for the
 *  add-on's code — the surrounding UI's own `addon.description` already covers
 *  unknown/newly-seeded add-ons, so a fallback here would just duplicate it. */
export function AddonExplainer({ addon }: { addon: BillingAddon }) {
  const detail = ADDON_DETAILS[addon.code];
  if (!detail) return null;
  return (
    <details
      className="group mt-3 border-t border-slate-100 pt-2"
      data-testid={`addon-explainer-${addon.code}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold text-slate-700 hover:text-slate-900">
        <span>What this does &amp; why it matters</span>
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-2 space-y-2 text-xs text-slate-600">
        <p>
          <span className="font-semibold text-slate-700">What it does:</span>{" "}
          {detail.whatItDoes}
        </p>
        <p>
          <span className="font-semibold text-slate-700">Why it matters:</span>{" "}
          {detail.whyItMatters}
        </p>
      </div>
    </details>
  );
}

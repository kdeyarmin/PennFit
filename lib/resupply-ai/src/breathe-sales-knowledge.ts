// @workspace/resupply-ai — sales knowledge base for the CareMetric Breathe
// B2B platform sales voice agent.
//
// This module is PLAIN STRINGS only: how the platform works and how the
// subscription/pricing models work, written for the voice agent to quote on a
// call with a prospective DME (durable medical equipment) business. It is
// composed into the `breathe_prospect` branch of `buildSystemPrompt()`.
//
// Why hardcode the pricing here (vs. reading the `billing_plans` table at
// call-open):
//   * The system prompt is built once, synchronously, inside the
//     RealtimeClient constructor. A DB round-trip there would couple this
//     pure AI lib to the data layer (forbidden by architecture Rule 9) and
//     add a failure/latency point to the moment the caller answers.
//   * The `billing_plans` table stores the monthly base + one-time setup fee
//     but NOT the per-active-patient meter the agent must quote, so the table
//     is not a complete source of truth for the spoken pitch anyway.
//   * Pinning the spoken pricing here keeps it auditable via PROMPT_VERSION.
//
// Keep these numbers in sync with docs/monetization-strategy-2026-06-15.md and
// the billing_plans catalog (migration 0362). When pricing changes, bump
// PROMPT_VERSION so the audit trail attributes the change.

/** What CareMetric Breathe is and what it does — the "how it works" pitch. */
export const BREATHE_PLATFORM_OVERVIEW = [
  "What CareMetric Breathe is:",
  "- An all-in-one operating system that DME (durable medical equipment) and",
  "  sleep businesses use to run their CPAP resupply program end to end. The",
  "  business keeps its own brand; CareMetric Breathe is the engine underneath.",
  "- A branded patient storefront with an AI mask-fitter, so patients can",
  "  reorder masks, cushions, tubing, and filters online or be guided to the",
  "  right mask by camera-based fitting (no images ever leave the browser).",
  "- Automated resupply outreach: SMS, email, and AI phone reminders that bring",
  "  patients back on schedule, plus Subscribe & Save auto-ship — this is what",
  "  lifts a resupply order rate from the typical ~30% toward the 45-50%",
  "  industry benchmark, which is the single biggest revenue lever for a DME.",
  "- Billing and revenue tools: insurance eligibility checks, prior-auth, claims",
  "  submission, denial work queues, and patient pay — so staff stop juggling",
  "  spreadsheets and clearinghouse portals.",
  "- Therapy monitoring that pulls compliance/usage data from ResMed AirView,",
  "  Philips Care Orchestrator, and 3B/React Health, so the team can see who is",
  "  due and who is struggling.",
  "- Built-in AI: a storefront chatbot, an admin copilot for staff, a clinical",
  "  sleep coach for patients, and this voice agent — all included.",
  "- Admin console, analytics, multi-location support, and integrations (e.g.",
  "  PacWare billing, Office Ally clearinghouse).",
  "",
  "Who it's for: DME providers, HME companies, and sleep labs that run — or",
  "want to run — a CPAP resupply program and want to grow it without adding",
  "headcount. It is NOT a consumer product; you are selling to the business.",
].join("\n");

/** The subscription / pricing model — tiers, the per-active-patient meter,
 *  and the common add-ons. These are the ONLY numbers the agent may quote. */
export const BREATHE_PRICING = [
  "How the subscription pricing works — every plan is a monthly platform fee",
  "PLUS a small per-active-patient monthly fee PLUS a one-time setup fee. An",
  '"active patient" is one with a resupply-eligible therapy record AND at least',
  "one outbound touch or order in the trailing 90 days — so the business only",
  "pays for patients the platform is actually working.",
  "",
  "Standalone product — Virtual Mask Fitter (Founder DME Launch price",
  "$119/month, regular $149, locked 12 months; no setup fee):",
  "the AI mask fitter on its OWN, for a DME that just wants to replace",
  "in-office mask fittings. Text or email a patient a link, they self-measure",
  "on their phone camera, and the perfect mask type + size comes back to the",
  "fitter worklist. Includes 25 completed fittings/month, then $2 per",
  "additional fitting. It is fitter-only — it does NOT include the storefront,",
  "resupply automation, or billing tools. A great low-commitment entry point;",
  "a DME can upgrade to a full plan below later.",
  "",
  "The virtual mask fitter is ALSO included in every full-platform plan below",
  "(same terms: 25 completed fittings/month included, then $2 per additional",
  "fitting) — the standalone plan is just for a DME that wants the fitter and",
  "nothing else.",
  "",
  "Full-platform plans (all include the full core platform — storefront,",
  "resupply automation, billing tools, admin console, AI assistants, analytics,",
  "and the AI virtual mask fitter). These are FOUNDER DME LAUNCH prices — a",
  "limited-time launch discount off our regular rates (regular Launch is $799,",
  "Growth $1,899, Scale $3,999) — and a DME that signs up during the launch",
  "has this founder",
  "rate GUARANTEED / LOCKED for a full 12 months:",
  "- Launch: $499/month + $1.25 per active patient per month, plus a $2,500",
  "  one-time setup. Best for under ~1,000 active patients.",
  "- Growth: $1,500/month + $0.95 per active patient per month, plus a $5,000",
  "  one-time setup. Best for ~1,000 to 10,000 active patients. This is the",
  "  most common starting point.",
  "- Scale: $3,199/month + $0.65 per active patient per month, plus a $10,000",
  "  one-time setup. Best for 10,000+ patients or multi-location operations.",
  "- Enterprise: custom pricing for the largest providers — dedicated database,",
  "  custom integrations, and a dedicated success manager.",
  "",
  "Optional add-ons (only if they ask, or it clearly fits their need):",
  "- AI voice agent (automated patient calls): about $499/month.",
  "- Advanced billing automation (auto-submit claims, AI denial work): about",
  "  $699/month.",
  "- Extra staff seats (about $49/month each), extra locations (about",
  "  $199/month each), SMS/email and AI-text bundles, and one-time data",
  "  migration from their old system.",
  "",
  "A quick way to frame value: a provider with a few thousand active patients",
  "typically pays a low single-digit percentage of the resupply revenue the",
  "platform helps them capture — and the order-rate lift usually more than",
  "covers the cost.",
].join("\n");

/** Combined knowledge block composed into the sales prompt. */
export const BREATHE_SALES_KNOWLEDGE = [
  BREATHE_PLATFORM_OVERVIEW,
  "",
  BREATHE_PRICING,
].join("\n");

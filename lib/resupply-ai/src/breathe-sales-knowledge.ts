// @workspace/resupply-ai — sales knowledge base for the CareMetric Breathe
// B2B platform sales voice agent.
//
// This module is PLAIN STRINGS only: how the platform works and how the
// subscription/pricing models work, written for the voice agent to quote on a
// call with a prospective DME (durable medical equipment) business. It is
// composed into the `breathe_prospect` branch of `buildSystemPrompt()`.
//
// Accuracy rule: everything here describes capabilities the platform actually
// ships. Do NOT add aspirational features. When the agent is asked about
// something not covered here (an edge feature, a custom integration, exact
// contract/BAA terms, or a specific onboarding timeline), it is instructed to
// be honest and capture a lead for a specialist follow-up rather than invent —
// so this file can stay the trustworthy floor of what the agent will assert.
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
// the billing_plans catalog (migration 0362/0426). When pricing changes, bump
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

/** Deeper, feature-by-feature detail so the agent can go in-depth when a
 *  caller wants to understand HOW a given capability actually works. */
export const BREATHE_FEATURE_DETAIL = [
  "How the main pieces actually work (use these to go deeper when a caller is",
  "curious — explain the one or two that matter to THEM, don't recite all of",
  "it):",
  "",
  "Branded patient storefront — each business runs its own brand and web",
  "address (its own storefront, logo, and domain); patients shop, see what",
  "they're due for, reorder masks/cushions/tubing/filters, check out, and track",
  "orders. It does not look like a third-party site — it's the DME's brand.",
  "",
  "AI Virtual Mask Fitter — the business texts or emails a patient a link; the",
  "patient self-measures on their phone camera, and the right mask type and size",
  "comes back to the fitter worklist. Crucially, the camera images NEVER leave",
  "the patient's phone — only the numeric measurements are sent — so it's",
  "private by design. It replaces opening sample masks in the office and cuts",
  "the guesswork that drives mask returns.",
  "",
  "Resupply automation — the platform tracks each patient's eligibility dates",
  "and reaches out automatically by SMS, email, and AI phone call when they're",
  "due. Patients confirm or decline right from a secure link (or by talking to",
  "an inbound AI line), and Subscribe & Save lets them go fully automatic so",
  "supplies just ship on schedule. This is the engine behind the order-rate",
  "lift.",
  "",
  "Therapy monitoring — it connects to ResMed AirView, Philips Care",
  "Orchestrator, and 3B/React Health to pull compliance and usage data, so the",
  "team can see who's due for resupply, who's struggling with therapy, and who",
  "to prioritize — without logging into three separate portals.",
  "",
  "Billing & revenue cycle — insurance eligibility checks, prior authorization,",
  "claims submission through the Office Ally clearinghouse, denial/work queues,",
  "bill-hold and A/R worklists, and patient pay. The goal is to stop staff from",
  "living in spreadsheets and clearinghouse portals.",
  "",
  "AI assistants (all included) — a storefront chatbot that answers patient",
  "questions and can even reply to patient emails, an admin copilot that helps",
  "staff find and do things in the console, a clinical sleep coach for patients,",
  "and this voice agent. They're tuned for healthcare and the business can",
  "rename them to its own brand.",
  "",
  "Admin console, analytics & operations — role-based staff accounts, bulk",
  "outreach campaigns and playbooks, document/e-signature handling, inbound fax",
  "triage, and analytics (revenue, funnel, LTV/CAC, inventory, team throughput,",
  "and KPI alerts). Higher tiers add multi-location workflows, automation rules,",
  "and a control center.",
  "",
  "Works with the systems they already have — it imports and exports with",
  "PacWare (the legacy desktop billing system) by file exchange, so PennFit-",
  "style resupply runs the front of the house while their billing system of",
  "record stays in place. Patient and therapy data can be migrated in during",
  "onboarding.",
].join("\n");

/** Why it's worth it — differentiators and the business case, so the agent
 *  can make a genuine, grounded value argument instead of just listing. */
export const BREATHE_VALUE_AND_DIFFERENTIATORS = [
  "Why DMEs choose it / how to frame the value (lead with the caller's own",
  "situation, not a feature dump):",
  "- The order-rate lift is the headline. Most DMEs convert ~30% of due",
  "  patients; consistent, automated, multi-channel outreach plus auto-ship",
  "  moves that toward the 45-50% benchmark. On an existing patient base that",
  "  is usually the single biggest revenue swing — and it's recurring.",
  "- Grow without adding headcount. The automation and AI do the repetitive",
  "  reach-out, fitting, and triage, so the same team handles far more patients.",
  "- One integrated system instead of stitched-together point tools. A generic",
  "  web cart can't check insurance eligibility, pull therapy compliance data,",
  "  schedule compliant resupply reminders, or fit a mask — this is purpose-",
  "  built for DME resupply, end to end.",
  "- You only pay for active patients the platform is actually working (the",
  "  per-active-patient meter), so cost scales with the value delivered.",
  "- Keep your brand and your billing system of record; this runs the resupply",
  "  engine on top.",
  "A simple ROI frame: a provider with a few thousand active patients typically",
  "pays a low single-digit percentage of the resupply revenue the platform helps",
  "them capture, and the order-rate lift usually more than covers the cost. If",
  "they share their rough patient count and current order rate, you can talk",
  "through that math with them in plain terms.",
].join("\n");

/** Common questions / objections and honest, grounded ways to address them. */
export const BREATHE_OBJECTIONS = [
  "Common questions and how to handle them honestly:",
  '- "We already have a website / online store." Generic e-commerce doesn\'t do',
  "  resupply scheduling, insurance eligibility, therapy-data-driven outreach,",
  "  or mask fitting. This is purpose-built for DME resupply — that's the",
  "  difference.",
  '- "Is it secure / HIPAA-conscious?" It\'s built to handle protected health',
  "  information carefully: mask-fitting images never leave the patient's phone,",
  "  patient data is isolated per business, and the AI is run on healthcare-",
  "  eligible providers. For specific security documentation or a Business",
  "  Associate Agreement, take their details and have a specialist follow up —",
  "  don't promise specific contract terms yourself.",
  '- "Switching sounds painful." They keep their brand; patient and therapy',
  "  data is migrated during onboarding, and it works alongside their existing",
  "  billing system (e.g. PacWare) rather than replacing it. There's a one-time",
  "  setup that covers getting them stood up.",
  '- "How long to get going / what\'s onboarding like?" The one-time setup fee',
  "  covers configuring their branded storefront, importing data, connecting",
  "  integrations, and training. For an exact timeline, capture a lead and have",
  "  the team confirm specifics — don't guess at dates.",
  '- "What about my billing system?" It exchanges patient and resupply data with',
  "  PacWare by file import/export; their billing system stays the system of",
  "  record while the platform drives resupply.",
  '- "It seems expensive." Reframe around the recurring revenue the order-rate',
  "  lift captures and the staff time saved; the per-active-patient model means",
  "  they pay in proportion to patients actually being worked.",
  "- Anything you're genuinely unsure of — an edge feature, a custom",
  "  integration, exact numbers, legal/contract terms — say you'll have the",
  "  right person follow up with specifics and capture the lead. Never invent a",
  "  capability, a price, or a commitment.",
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
  "Growth $1,899, Scale $3,999) — and a DME that signs up during the launch has",
  "this founder rate GUARANTEED / LOCKED for a full 12 months:",
  "- Launch: $499/month + $1.25 per active patient per month, plus a $2,500",
  "  one-time setup. Best for under ~1,000 active patients (about 5 staff seats,",
  "  one location).",
  "- Growth: $1,500/month + $0.95 per active patient per month, plus a $5,000",
  "  one-time setup. Best for ~1,000 to 10,000 active patients (about 15 seats,",
  "  up to a few locations). This is the most common starting point.",
  "- Scale: $3,199/month + $0.65 per active patient per month, plus a $10,000",
  "  one-time setup. Best for 10,000+ patients or multi-location operations",
  "  (about 40 seats, up to ~10 locations), and it adds the advanced multi-",
  "  location, automation, and analytics tooling.",
  "- Enterprise: custom pricing for the largest providers — dedicated database,",
  "  custom integrations, and a dedicated success manager. Always route",
  "  Enterprise to a human follow-up; never quote or sign it on the call.",
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
  BREATHE_FEATURE_DETAIL,
  "",
  BREATHE_VALUE_AND_DIFFERENTIATORS,
  "",
  BREATHE_OBJECTIONS,
  "",
  BREATHE_PRICING,
].join("\n");

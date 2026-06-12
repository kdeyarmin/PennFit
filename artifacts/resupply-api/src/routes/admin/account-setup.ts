// /admin/account-setup — new-account / production launch checklist.
//
// A read-only "is this done?" feed for standing up a fresh PennFit
// deployment, surfaced as a two-tab checklist in the admin console
// (Settings -> Account Setup). It mirrors the procedure in
// docs/runbooks/production-launch.md:
//
//   * REQUIRED tab — the launch spine: the env the API needs at boot,
//     the database schema, the first admin, and the preflight /
//     migrate / smoke-test steps an operator runs by hand.
//   * OPTIONAL tab — the feature-gated vendor integrations (Stripe,
//     SendGrid, Twilio, the AI/voice stack, billing clearinghouse,
//     therapy-cloud pulls, ...) that degrade gracefully when unset.
//
// Privacy posture (identical to /admin/system-info): env-var VALUES
// are NEVER returned — only "is this set?" booleans and small live
// counts. There is no raw pg / drizzle here; the only data path is the
// Supabase service-role client, and every DB probe is individually
// wrapped so this page still renders when the database isn't set up
// yet — which is the whole point of a setup checklist.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { hasLinkHmacKey } from "@workspace/resupply-secrets";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Deep-links point at the canonical repo so an operator can open the
// matching runbook straight from a checklist row.
const DOC_BASE = "https://github.com/kdeyarmin/PennFit/blob/main/";
const doc = (path: string): string => `${DOC_BASE}${path}`;

export type AccountSetupItemStatus =
  | "complete"
  | "incomplete"
  | "manual"
  | "unknown";

export interface AccountSetupItem {
  id: string;
  tab: "required" | "optional";
  group: string;
  title: string;
  description: string;
  status: AccountSetupItemStatus;
  /** Human-readable live detail (never an env-var value). */
  detail: string | null;
  /** Absolute URL to a runbook / doc, when one applies. */
  docHref: string | null;
  /** Shell command an operator can copy-run, when one applies. */
  command: string | null;
}

/** A wrapped probe outcome for the two DB-derived rows. */
export interface ProbeResult {
  status: AccountSetupItemStatus;
  detail: string | null;
}

export interface BuildChecklistInput {
  env: NodeJS.ProcessEnv;
  /** Result of hasLinkHmacKey() — passed in so the assembler stays pure. */
  linkHmacConfigured: boolean;
  schema: ProbeResult;
  admin: ProbeResult;
}

const isSet = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "";
};

interface VendorSpec {
  id: string;
  group: string;
  title: string;
  description: string;
  configured: boolean;
  /** What to set to turn it on (shown only when not configured). */
  envHint: string;
  docHref?: string | null;
}

function vendorItem(spec: VendorSpec): AccountSetupItem {
  return {
    id: spec.id,
    tab: "optional",
    group: spec.group,
    title: spec.title,
    description: spec.description,
    status: spec.configured ? "complete" : "incomplete",
    detail: spec.configured
      ? "Configured."
      : `Not set up — set ${spec.envHint}.`,
    docHref: spec.docHref ?? null,
    command: null,
  };
}

/**
 * Pure assembler — given the current env plus the two DB-probe
 * outcomes, produce the full ordered checklist. Kept pure (no I/O) so
 * it is exhaustively unit-testable without the Supabase mock.
 */
export function buildChecklistItems(
  input: BuildChecklistInput,
): AccountSetupItem[] {
  const { env, linkHmacConfigured, schema, admin } = input;

  const supabaseConfigured =
    isSet(env, "SUPABASE_URL") && isSet(env, "SUPABASE_SERVICE_ROLE_KEY");
  const supabaseMissing = [
    isSet(env, "SUPABASE_URL") ? null : "SUPABASE_URL",
    isSet(env, "SUPABASE_SERVICE_ROLE_KEY")
      ? null
      : "SUPABASE_SERVICE_ROLE_KEY",
  ]
    .filter(Boolean)
    .join(", ");
  const supabaseDetail = supabaseConfigured
    ? "Both set."
    : `Missing: ${supabaseMissing}.`;

  const corsConfigured =
    isSet(env, "RESUPPLY_ALLOWED_ORIGINS") ||
    isSet(env, "RAILWAY_PUBLIC_DOMAIN");
  let corsDetail = "Neither is set.";
  if (corsConfigured) {
    corsDetail = isSet(env, "RAILWAY_PUBLIC_DOMAIN")
      ? "RAILWAY_PUBLIC_DOMAIN is set."
      : "RESUPPLY_ALLOWED_ORIGINS is set.";
  }

  const stripeConfigured = isSet(env, "STRIPE_SECRET_KEY");
  const stripeWebhook = isSet(env, "STRIPE_WEBHOOK_SIGNING_SECRET");
  let stripeDetail =
    "Not set up — set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SIGNING_SECRET.";
  if (stripeConfigured) {
    stripeDetail = stripeWebhook
      ? "Configured (secret key + webhook signing secret)."
      : "Secret key set, but STRIPE_WEBHOOK_SIGNING_SECRET is missing — checkout works, fulfillment webhooks won't verify.";
  }

  const required: AccountSetupItem[] = [
    {
      id: "env-database-url",
      tab: "required",
      group: "Required environment",
      title: "Database connection",
      description:
        "DATABASE_URL — Postgres connection used by the migrator and the legacy worker paths.",
      status: isSet(env, "DATABASE_URL") ? "complete" : "incomplete",
      detail: isSet(env, "DATABASE_URL")
        ? "Set."
        : "Not set — the API refuses to boot without it.",
      docHref: doc("docs/runbooks/production-launch.md"),
      command: null,
    },
    {
      id: "env-supabase",
      tab: "required",
      group: "Required environment",
      title: "Supabase runtime data path",
      description:
        "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — the runtime read/write path (PostgREST). The service-role JWT bypasses RLS; never expose it client-side.",
      status: supabaseConfigured ? "complete" : "incomplete",
      detail: supabaseDetail,
      docHref: doc("docs/runbooks/production-launch.md"),
      command: null,
    },
    {
      id: "env-link-hmac",
      tab: "required",
      group: "Required environment",
      title: "Patient-link signing key",
      description:
        "RESUPPLY_LINK_HMAC_KEY — 32+ random bytes that sign the short-lived patient links in SMS/email reminders.",
      status: linkHmacConfigured ? "complete" : "incomplete",
      detail: linkHmacConfigured
        ? "Set."
        : "Not set — generate a fresh value, then store it as a secret.",
      docHref: doc("docs/runbooks/production-launch.md"),
      command: linkHmacConfigured ? null : "openssl rand -base64 48",
    },
    {
      id: "env-cors",
      tab: "required",
      group: "Required environment",
      title: "CORS allowlist",
      description:
        "RESUPPLY_ALLOWED_ORIGINS or RAILWAY_PUBLIC_DOMAIN — in production the API throws at boot if both are empty. Railway auto-populates RAILWAY_PUBLIC_DOMAIN.",
      status: corsConfigured ? "complete" : "incomplete",
      detail: corsDetail,
      docHref: null,
      command: null,
    },
    {
      id: "env-storage-bucket",
      tab: "required",
      group: "Required environment",
      title: "Private storage bucket",
      description:
        "SUPABASE_STORAGE_BUCKET_PRIVATE — bucket for POD photos, prescription PDFs, and MMS media. The PHI sweep job refuses to register without it.",
      status: isSet(env, "SUPABASE_STORAGE_BUCKET_PRIVATE")
        ? "complete"
        : "incomplete",
      detail: isSet(env, "SUPABASE_STORAGE_BUCKET_PRIVATE")
        ? "Set."
        : "Not set.",
      docHref: null,
      command: null,
    },
    {
      id: "db-schema",
      tab: "required",
      group: "Database",
      title: "Database schema present",
      description:
        "The resupply schema is reachable through PostgREST — confirms both schemas are exposed in Supabase Studio and the migrations have populated the database.",
      status: schema.status,
      detail: schema.detail,
      docHref: doc("docs/runbooks/production-launch.md"),
      command: null,
    },
    {
      id: "db-migrations",
      tab: "required",
      group: "Database",
      title: "Apply database migrations",
      description:
        "Production's migration ledger is adopted and RUN_DB_MIGRATIONS is on, so every deploy auto-applies the pending tail via Railway's preDeployCommand — the one-time baseline is already done. Run this by hand only to apply a tail out-of-band, or against a fresh database (which replays from 0000).",
      status: "manual",
      detail:
        "Adopted — auto-runs on deploy. A manual run is a no-op when current; tick once the migrator prints “migrations up to date”.",
      docHref: doc("docs/runbooks/adopt-migration-ledger.md"),
      command: "pnpm --filter @workspace/resupply-db run migrate",
    },
    {
      id: "first-admin",
      tab: "required",
      group: "Access",
      title: "Bootstrap the first admin",
      description:
        "Seed the first admin row and email a 1-hour password-reset link. No one can sign into /admin without this; later admins are invited from Settings -> Team.",
      status: admin.status,
      detail: admin.detail,
      docHref: doc("docs/runbooks/production-launch.md"),
      command:
        admin.status === "complete"
          ? null
          : "pnpm --filter @workspace/scripts auth:bootstrap-admin --email=you@example.com --role=admin",
    },
    {
      id: "preflight",
      tab: "required",
      group: "Verification",
      title: "Run the production preflight check",
      description:
        "Validates env shape — sk_live vs sk_test, base64 HMAC round-trip, HTTPS-only public URLs, placeholder detection. Exits non-zero on any FAIL so it can gate a deploy.",
      status: "manual",
      detail: "Tick once it prints “Ready for launch.” with no FAILs.",
      docHref: doc("docs/runbooks/production-launch.md"),
      command: "pnpm --filter @workspace/scripts preflight:prod",
    },
    {
      id: "smoke-test",
      tab: "required",
      group: "Verification",
      title: "Post-deploy smoke test",
      description:
        "Confirms the API (not just the SPA) is actually routed after a deploy — probes /resupply-api/healthz and the public shop catalog.",
      status: "manual",
      detail: "Run after each deploy; the probe must exit 0.",
      docHref: doc("docs/runbooks/production-launch.md"),
      command:
        "pnpm --filter @workspace/scripts verify:deploy -- https://<your-host>",
    },
  ];

  const optional: AccountSetupItem[] = [
    {
      id: "vendor-stripe",
      tab: "optional",
      group: "Payments",
      title: "Stripe",
      description:
        "Cash-pay storefront checkout and refunds. Strongly recommended before opening the shop.",
      status: stripeConfigured ? "complete" : "incomplete",
      detail: stripeDetail,
      docHref: null,
      command: null,
    },
    vendorItem({
      id: "vendor-sendgrid",
      group: "Email",
      title: "SendGrid",
      description:
        "Outbound email — receipts, reminders, review requests, password resets. The From address must be info@pennpaps.com.",
      configured: isSet(env, "SENDGRID_API_KEY"),
      envHint: "SENDGRID_API_KEY",
    }),
    vendorItem({
      id: "vendor-twilio-sms",
      group: "Messaging",
      title: "Twilio SMS",
      description: "Outbound + inbound resupply SMS and MMS attachments.",
      configured:
        isSet(env, "TWILIO_ACCOUNT_SID") &&
        isSet(env, "TWILIO_AUTH_TOKEN") &&
        isSet(env, "TWILIO_MESSAGING_SERVICE_SID"),
      envHint:
        "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_MESSAGING_SERVICE_SID",
    }),
    vendorItem({
      id: "vendor-twilio-voice",
      group: "Voice",
      title: "Twilio Voice",
      description: "Inbound/outbound voice calls for the AI voice agent.",
      configured:
        isSet(env, "TWILIO_ACCOUNT_SID") &&
        isSet(env, "TWILIO_AUTH_TOKEN") &&
        isSet(env, "TWILIO_VOICE_PHONE_NUMBER"),
      envHint:
        "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_VOICE_PHONE_NUMBER",
    }),
    vendorItem({
      id: "vendor-openai",
      group: "AI",
      title: "OpenAI",
      description:
        "Voice-agent brain + realtime transcription, and the text-LLM fallback when Anthropic isn't set.",
      configured: isSet(env, "OPENAI_API_KEY"),
      envHint: "OPENAI_API_KEY",
    }),
    vendorItem({
      id: "vendor-anthropic",
      group: "AI",
      title: "Anthropic (Claude)",
      description:
        "Preferred text-LLM provider — storefront chatbot, sleep coach, SMS classifier, post-call summaries. Falls back to OpenAI when unset.",
      configured: isSet(env, "ANTHROPIC_API_KEY"),
      envHint: "ANTHROPIC_API_KEY",
    }),
    vendorItem({
      id: "vendor-elevenlabs",
      group: "Voice",
      title: "ElevenLabs",
      description:
        "Premium TTS voice for the phone agent. Falls back to OpenAI's built-in voice when unset.",
      configured: isSet(env, "ELEVENLABS_API_KEY"),
      envHint: "ELEVENLABS_API_KEY",
    }),
    vendorItem({
      id: "vendor-deepgram",
      group: "Voice",
      title: "Deepgram",
      description:
        "Audit-grade backup transcript for voice calls. Falls back to the OpenAI Realtime transcript when unset.",
      configured: isSet(env, "DEEPGRAM_API_KEY"),
      envHint: "DEEPGRAM_API_KEY",
    }),
    vendorItem({
      id: "vendor-office-ally",
      group: "Billing & claims",
      title: "Office Ally clearinghouse",
      description:
        "837P claim submission over SFTP. Identity + connection are preferably set in Billing -> Config (DB), which overrides env. Stub/outbox mode runs when unconfigured.",
      configured:
        isSet(env, "OFFICE_ALLY_USERNAME") &&
        isSet(env, "OFFICE_ALLY_ETIN") &&
        isSet(env, "OFFICE_ALLY_BILLING_NPI"),
      envHint:
        "the OFFICE_ALLY_* SFTP + billing-identity vars (or OFFICE_ALLY_STUB=1)",
    }),
    vendorItem({
      id: "vendor-therapy",
      group: "Device data",
      title: "Therapy-cloud integrations",
      description:
        "Pull device/usage data from ResMed AirView, Philips Care Orchestrator, or 3B React Health. Each vendor is independent.",
      configured:
        isSet(env, "AIRVIEW_CLIENT_ID") ||
        isSet(env, "CARE_ORCHESTRATOR_CLIENT_ID") ||
        isSet(env, "REACT_HEALTH_CLIENT_ID"),
      envHint:
        "a vendor's client id/secret + base/token URLs (AIRVIEW_*, CARE_ORCHESTRATOR_*, or REACT_HEALTH_*)",
    }),
    vendorItem({
      id: "vendor-telnyx-fax",
      group: "Fax",
      title: "Telnyx Fax",
      description:
        "Physician-fax Rx-renewal outreach. Requires the Telnyx API key + fax connection id, a fax-enabled number, and a public base URL.",
      configured:
        isSet(env, "TELNYX_API_KEY") &&
        isSet(env, "TELNYX_FAX_CONNECTION_ID") &&
        isSet(env, "TELNYX_FAX_FROM_NUMBER") &&
        isSet(env, "TELNYX_PUBLIC_KEY") &&
        (isSet(env, "RESUPPLY_VOICE_PUBLIC_BASE_URL") ||
          isSet(env, "RAILWAY_PUBLIC_DOMAIN")),
      envHint:
        "TELNYX_API_KEY + TELNYX_FAX_CONNECTION_ID + TELNYX_FAX_FROM_NUMBER + TELNYX_PUBLIC_KEY (with a public base URL)",
    }),
    vendorItem({
      id: "vendor-web-push",
      group: "Notifications",
      title: "Web Push (VAPID)",
      description:
        "Browser push notifications. When unset the “Enable push” toggle is hidden in the SPA.",
      configured:
        isSet(env, "WEB_PUSH_VAPID_PUBLIC_KEY") &&
        isSet(env, "WEB_PUSH_VAPID_PRIVATE_KEY") &&
        isSet(env, "WEB_PUSH_VAPID_SUBJECT"),
      envHint:
        "WEB_PUSH_VAPID_PUBLIC_KEY + WEB_PUSH_VAPID_PRIVATE_KEY + WEB_PUSH_VAPID_SUBJECT",
    }),
    vendorItem({
      id: "vendor-public-bucket",
      group: "Storage",
      title: "Public storage bucket",
      description:
        "Optional separate Supabase Storage bucket for public assets (for example, product imagery).",
      configured: isSet(env, "SUPABASE_STORAGE_BUCKET_PUBLIC"),
      envHint: "SUPABASE_STORAGE_BUCKET_PUBLIC",
    }),
  ];

  return [...required, ...optional];
}

// --- live DB probes ---------------------------------------------------
// Each probe is fully wrapped: a database that isn't set up yet (or a
// transient outage) yields an "unknown" row with a reason, never a 500.

async function probeSchema(): Promise<ProbeResult> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    // The same lightweight HEAD count /readyz uses. Success doubles as
    // confirmation the resupply schema is exposed to PostgREST.
    const { error } = await supabase
      .schema("resupply")
      .from("feature_flags")
      .select("*", { count: "estimated", head: true });
    if (error) {
      return {
        status: "unknown",
        detail: `Couldn't verify the schema: ${error.message}. On a fresh install this is expected until migrations run.`,
      };
    }
    return {
      status: "complete",
      detail:
        "Database reachable; the resupply schema is present and exposed to PostgREST.",
    };
  } catch (err) {
    return {
      status: "unknown",
      detail: `Couldn't reach the database: ${err instanceof Error ? err.message : "unknown error"}.`,
    };
  }
}

async function probeFirstAdmin(): Promise<ProbeResult> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { count, error } = await supabase
      .schema("resupply")
      .from("admin_users")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      .eq("role", "admin");
    if (error) {
      return {
        status: "unknown",
        detail: `Couldn't verify admin accounts: ${error.message}.`,
      };
    }
    const n = count ?? 0;
    if (n > 0) {
      return {
        status: "complete",
        detail: `${n} active admin account${n === 1 ? "" : "s"} on file.`,
      };
    }
    return {
      status: "incomplete",
      detail: "No active admin accounts yet — bootstrap the first one.",
    };
  } catch (err) {
    return {
      status: "unknown",
      detail: `Couldn't reach the database: ${err instanceof Error ? err.message : "unknown error"}.`,
    };
  }
}

router.get(
  "/admin/account-setup",
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res) => {
    const [schema, admin] = await Promise.all([
      probeSchema(),
      probeFirstAdmin(),
    ]);
    const items = buildChecklistItems({
      env: process.env,
      linkHmacConfigured: hasLinkHmacKey(),
      schema,
      admin,
    });
    res.json({
      generatedAt: new Date().toISOString(),
      environment: process.env.NODE_ENV ?? null,
      items,
    });
  },
);

export default router;
